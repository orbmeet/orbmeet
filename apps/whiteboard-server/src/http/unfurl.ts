import { type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import {
  MAX_UNFURL_REDIRECTS,
  UnsafeUnfurlTargetError,
  assertSafeUnfurlTarget,
} from "./net-security.ts";
import { isPublicBrowserHost, stripIpv6Brackets } from "@orbmeet/whiteboard-core/public-host";
import {
  MAX_HTTP_BODY_BYTES,
  getContentLength,
  jsonBodyErrorReply,
  readBoundedJson,
} from "./http.ts";
import { decodeHtmlEntities } from "./html-entities.ts";
import { Reply } from "./reply.ts";
import { WHITEBOARD_CONFIG } from "@orbmeet/whiteboard-core/config";

const MAX_UNFURL_RESPONSE_BYTES = 1 * 1024 * 1024;

// Title and description are third-party page content that ends up verbatim in
// a synced bookmark asset on every participant's canvas. Without a cap the only
// bound is MAX_UNFURL_RESPONSE_BYTES, so a hostile page could put ~1 MB of
// og:description into a CRDT record. rooms/page-frame-guard.ts rejects anything above
// the same ceilings on the synced record, so this clamp keeps our own unfurler
// from producing a record that guard would refuse.
function clampUnfurlText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

type PinnedUnfurlResponse = {
  status: number;
  ok: boolean;
  headers: Map<string, string>;
  body: Uint8Array;
};

function getPinnedHeader(headers: Map<string, string>, name: string): string | null {
  return headers.get(name.toLowerCase()) ?? null;
}

// Only these get parsed as markup. The set is matched against the header's
// media type, never as a substring of the whole header: parameters are
// attacker-influenced text, so `image/png; charset=utf-8; x=text/html` contains
// "text/html" without being it, and a bare `includes` would hand a binary body
// to the meta-tag extractor.
const UNFURLABLE_MEDIA_TYPES = new Set([
  "text/html",
  "text/plain",
  "application/xhtml+xml",
  "application/xhtml",
]);

export function isUnfurlableMediaType(headerValue: string): boolean {
  const mediaType = headerValue.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return UNFURLABLE_MEDIA_TYPES.has(mediaType);
}

export function resolveUnfurlRedirect(currentUrl: URL, location: string): URL {
  let nextUrl: URL;
  try {
    nextUrl = new URL(location, currentUrl);
  } catch {
    throw new UnsafeUnfurlTargetError("Redirect URL is invalid");
  }
  if (!["http:", "https:"].includes(nextUrl.protocol)) {
    throw new UnsafeUnfurlTargetError("Redirect protocol is not allowed");
  }
  if (currentUrl.protocol === "https:" && nextUrl.protocol !== "https:") {
    throw new UnsafeUnfurlTargetError("HTTPS redirect downgrade is not allowed");
  }
  return nextUrl;
}

function hostHeaderForUrl(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

function requestPinnedUnfurlUrl(
  url: URL,
  resolvedAddress: string,
  signal: AbortSignal,
): Promise<PinnedUnfurlResponse> {
  return new Promise((resolve, reject) => {
    const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requestImpl(
      {
        protocol: url.protocol,
        hostname: resolvedAddress,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: url.protocol === "https:" ? stripIpv6Brackets(url.hostname) : undefined,
        lookup: (_hostname, _options, callback) => {
          callback(null, resolvedAddress, isIP(resolvedAddress) || 4);
        },
        headers: {
          Host: hostHeaderForUrl(url),
          "User-Agent": "OrbMeet/1.0 (whiteboard unfurler)",
          Accept: "text/html",
        },
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        let truncated = false;
        let settled = false;

        response.on("data", (chunk: Uint8Array | Buffer) => {
          if (truncated) return;
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          if (totalBytes + bytes.byteLength > MAX_UNFURL_RESPONSE_BYTES) {
            const remaining = Math.max(0, MAX_UNFURL_RESPONSE_BYTES - totalBytes);
            if (remaining > 0) {
              chunks.push(bytes.slice(0, remaining));
              totalBytes += remaining;
            }
            truncated = true;
            request.destroy();
            return;
          }
          totalBytes += bytes.byteLength;
          chunks.push(bytes);
        });

        const finish = () => {
          if (settled) return;
          settled = true;
          const body = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }

          const headers = new Map<string, string>();
          for (const [key, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) headers.set(key.toLowerCase(), value.join(", "));
            else if (typeof value === "string") headers.set(key.toLowerCase(), value);
          }

          const status = response.statusCode ?? 0;
          resolve({ status, ok: status >= 200 && status < 300, headers, body });
        };

        response.on("end", finish);
        response.on("close", () => {
          if (truncated) finish();
        });
      },
    );

    const abort = () => request.destroy(new Error("Request aborted"));
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    request.on("error", reject);
    request.on("close", () => signal.removeEventListener("abort", abort));
    request.end();
  });
}

// Anchored at both ends over a single character class, so one start position
// and no alternation: matching stays linear in the name's length.
const ATTRIBUTE_NAME_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;

function isHtmlSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

/**
 * Attribute scanner for one `<meta …>` tag.
 *
 * Single forward pass, deliberately: the equivalent regex
 * (`([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(…)`) backtracks quadratically on a
 * name-shaped run that is never followed by `=`. A `<meta>` tag holding ~1 MB
 * of `a` — the response cap, and entirely attacker-chosen page content — took
 * tens of minutes to scan, on the one event loop every room and socket on this
 * host shares. Any bounded-lookahead rewrite is fine; what matters is that no
 * character is examined more than a constant number of times.
 *
 * Only attributes that actually carry `=` are recorded, and only under a name
 * matching the character classes above. A valueless or malformed-name token is
 * skipped whole rather than rescanned from its interior, so `9content="x"`
 * contributes nothing instead of yielding a `content` the page never declared.
 */
function parseMetaTagAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let index = 0;

  while (index < tag.length) {
    if (isHtmlSpace(tag[index]) || tag[index] === "/") {
      index += 1;
      continue;
    }

    // A name is every character up to the delimiter that ends it. Reading the
    // whole token — even one that cannot be a valid name — is what keeps the
    // scan linear: the alternative is restarting inside a token we rejected.
    const nameStart = index;
    while (
      index < tag.length &&
      !isHtmlSpace(tag[index]) &&
      tag[index] !== "=" &&
      tag[index] !== ">" &&
      tag[index] !== "/"
    ) {
      index += 1;
    }
    const name = tag.slice(nameStart, index);

    while (index < tag.length && isHtmlSpace(tag[index])) index += 1;
    if (tag[index] !== "=") {
      // Valueless attribute (or the tag's closing `>`): nothing to record, and
      // the next iteration resumes at a delimiter rather than inside `name`.
      if (tag[index] === ">") break;
      continue;
    }
    index += 1;
    while (index < tag.length && isHtmlSpace(tag[index])) index += 1;

    let value: string;
    const quote = tag[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      const valueStart = index;
      while (index < tag.length && tag[index] !== quote) index += 1;
      value = tag.slice(valueStart, index);
      if (index < tag.length) index += 1;
    } else {
      const valueStart = index;
      while (
        index < tag.length &&
        !isHtmlSpace(tag[index]) &&
        tag[index] !== '"' &&
        tag[index] !== "'" &&
        tag[index] !== ">"
      ) {
        index += 1;
      }
      value = tag.slice(valueStart, index);
    }

    if (ATTRIBUTE_NAME_RE.test(name)) {
      // Last declaration wins, matching the scan this replaced.
      attrs[name.toLowerCase()] = value;
    }
  }

  return attrs;
}

const META_TAG_NAME = "meta";

function isAsciiWordChar(char: string | undefined): boolean {
  if (char === undefined) return false;
  return (
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") ||
    char === "_"
  );
}

/**
 * Tag scanner for a whole document.
 *
 * Single forward pass, for the same reason parseMetaTagAttributes is: the
 * regex this replaced (`/<meta\b[^>]*>/gi`) rescans the entire remaining input
 * for every `<meta` that is never closed, so `"<meta".repeat(n)` costs O(n²)
 * on the one event loop every room and socket on this host shares. None of the
 * defenses around it bound that work — the public-target checks, the 1 MiB
 * response cap and the fetch timeout are all upstream of a synchronous scan,
 * and the timeout is cleared before this runs.
 *
 * Every index here only moves forward, so no character is examined more than a
 * constant number of times. The first `>` after the tag name ends the tag, the
 * same boundary the regex used.
 */
export function extractMetaTags(html: string): Map<string, string> {
  const meta = new Map<string, string>();
  let index = 0;

  while (index < html.length) {
    const bracket = html.indexOf("<", index);
    if (bracket === -1) break;

    const nameEnd = bracket + 1 + META_TAG_NAME.length;
    if (
      html.slice(bracket + 1, nameEnd).toLowerCase() !== META_TAG_NAME ||
      // The `\b` the regex spelled: `<metadata>` is not a `<meta>` tag.
      isAsciiWordChar(html[nameEnd])
    ) {
      index = bracket + 1;
      continue;
    }

    // No closing `>` anywhere in the remainder means no further tag can close
    // either, so there is nothing left to find rather than n more full scans.
    const tagEnd = html.indexOf(">", nameEnd);
    if (tagEnd === -1) break;

    const attrs = parseMetaTagAttributes(html.slice(nameEnd, tagEnd));
    index = tagEnd + 1;

    const key = (attrs.property || attrs.name || "").trim().toLowerCase();
    const content = (attrs.content || "").trim();
    if (!key || !content || meta.has(key)) continue;
    meta.set(key, content);
  }

  return meta;
}

const TITLE_OPEN = "<title";
const TITLE_CLOSE = "</title>";

/**
 * The raw text of the first `<title …>text</title>` whose text holds no `<`,
 * or null.
 *
 * Single forward pass, for the same reason extractMetaTags is: the regex this
 * replaced (`/<title[^>]*>([^<]*)<\/title>/i`) rescans to the end of the input
 * for every `<title` that has no `>` after it, so `"<title".repeat(n)` held
 * the host's shared event loop for ~12s at 480KB on Bun. Every candidate whose
 * first `>` is the one a failed candidate already reached fails the same way,
 * so the scan resumes past that `>` rather than rediscovering it.
 */
export function extractTitle(html: string): string | null {
  let index = 0;

  while (index < html.length) {
    const bracket = html.indexOf("<", index);
    if (bracket === -1) return null;

    const nameEnd = bracket + TITLE_OPEN.length;
    if (html.slice(bracket, nameEnd).toLowerCase() !== TITLE_OPEN) {
      index = bracket + 1;
      continue;
    }

    // No `>` or no `<` in the remainder means no later candidate can close.
    const tagEnd = html.indexOf(">", nameEnd);
    if (tagEnd === -1) return null;
    const textEnd = html.indexOf("<", tagEnd + 1);
    if (textEnd === -1) return null;
    if (html.slice(textEnd, textEnd + TITLE_CLOSE.length).toLowerCase() === TITLE_CLOSE) {
      return html.slice(tagEnd + 1, textEnd);
    }

    // A later `<title` that starts early enough to share this `>` fails the
    // same way; the first one that could differ begins inside the last few
    // characters before it.
    index = Math.max(bracket + 1, tagEnd - TITLE_OPEN.length + 1);
  }

  return null;
}

export async function handleUnfurl(req: IncomingMessage): Promise<Reply> {
  const contentLength = getContentLength(req);
  if (contentLength !== null && contentLength > MAX_HTTP_BODY_BYTES) {
    return Reply.json({ error: "Request too large" }, 413);
  }

  let body: { url?: string };
  try {
    body = await readBoundedJson<{ url?: string }>(req);
  } catch (error) {
    return jsonBodyErrorReply(error);
  }

  if (!body.url || typeof body.url !== "string") {
    return Reply.json({ error: "Missing url" }, 400);
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(body.url);
  } catch {
    return Reply.json({ error: "Invalid URL" }, 400);
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    return Reply.json({ error: "Only http/https URLs supported" }, 400);
  }

  try {
    let currentUrl = targetUrl;
    let html = "";
    // An HTML response with an empty body is a successful fetch with nothing to
    // parse, which is not the same as exhausting the redirect budget.
    let fetched = false;

    for (let redirects = 0; redirects <= MAX_UNFURL_REDIRECTS; redirects++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        // DNS and the pinned HTTP request share one per-hop deadline. A hostile
        // nameserver cannot consume an unbounded pre-request interval.
        const resolvedAddresses = await assertSafeUnfurlTarget(currentUrl, controller.signal);
        const resp = await requestPinnedUnfurlUrl(
          currentUrl,
          resolvedAddresses[0] ?? currentUrl.hostname,
          controller.signal,
        );

        if (resp.status >= 300 && resp.status < 400) {
          const location = getPinnedHeader(resp.headers, "Location");
          if (!location) {
            return Reply.json({ title: currentUrl.hostname, url: body.url });
          }
          currentUrl = resolveUnfurlRedirect(currentUrl, location);
          continue;
        }

        if (!resp.ok) {
          return Reply.json({ title: currentUrl.hostname, url: body.url });
        }

        const respContentType = getPinnedHeader(resp.headers, "Content-Type") ?? "";
        if (!isUnfurlableMediaType(respContentType)) {
          return Reply.json({ title: currentUrl.hostname, url: body.url });
        }

        html = new TextDecoder().decode(resp.body);
        targetUrl = currentUrl;
        fetched = true;
        break;
      } finally {
        clearTimeout(timeout);
      }
    }

    if (!fetched) {
      return Reply.json({ error: "Too many redirects" }, 400);
    }
    if (!html) {
      return Reply.json({ title: targetUrl.hostname, url: body.url });
    }

    const metadata = extractMetaTags(html);
    const getMeta = (property: string): string | null => {
      const value = metadata.get(property.toLowerCase());
      return value ? decodeHtmlEntities(value) : null;
    };

    const getTitle = (): string => {
      const title =
        getMeta("og:title") ||
        getMeta("twitter:title") ||
        decodeHtmlEntities(extractTitle(html)?.trim() || "") ||
        targetUrl.hostname;
      return clampUnfurlText(title, WHITEBOARD_CONFIG.MAX_BOOKMARK_TITLE_LENGTH);
    };

    const getDescription = (): string | null => {
      const description =
        getMeta("og:description") || getMeta("twitter:description") || getMeta("description");
      return description
        ? clampUnfurlText(description, WHITEBOARD_CONFIG.MAX_BOOKMARK_DESCRIPTION_LENGTH)
        : null;
    };

    const getImage = (): string | null => {
      const img = getMeta("og:image") || getMeta("twitter:image");
      if (!img) return null;
      try {
        const resolved = new URL(img, targetUrl.toString());
        // The preview image becomes an <img src> on every participant's screen,
        // so it must be an http(s) URL pointing at a public host. See
        // isPublicBrowserHost for why isSuspiciousHostname alone is insufficient.
        if (!["http:", "https:"].includes(resolved.protocol)) return null;
        if (!isPublicBrowserHost(resolved.hostname)) return null;
        return resolved.toString();
      } catch {
        return null;
      }
    };

    return Reply.json({
      title: getTitle(),
      description: getDescription(),
      image: getImage(),
      url: body.url,
    });
  } catch (error) {
    if (error instanceof UnsafeUnfurlTargetError) {
      return Reply.json({ error: "Unable to fetch link preview" }, 400);
    }
    return Reply.json({ title: targetUrl.hostname, url: body.url });
  }
}

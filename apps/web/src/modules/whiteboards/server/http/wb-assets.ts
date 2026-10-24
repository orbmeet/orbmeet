import { createDb } from "@orbmeet/db";
import { meetingWhiteboards, whiteboardRevisions } from "@orbmeet/db/schema";
import { and, eq } from "drizzle-orm";
import { verifyWhiteboardJWT } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import { whiteboardJwtKeyring } from "@/platform/realtime/nodes";
import { syncRoomIdFromWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { extractWhiteboardDocumentAssetIdentity } from "@orbmeet/whiteboard-core/whiteboard-asset-key";
import { getWhiteboardAssetTokenFromCookie } from "@/modules/whiteboards/server/cookies";
import { verifySessionFromRawRequest } from "@/modules/identity/server/session";
import { canAccessMeetingHistory } from "@/modules/meetings/server/access/resource-access";
import {
  canActiveParticipantReadWhiteboardAsset,
  canRecorderReadWhiteboardAsset,
} from "@/modules/whiteboards/server/meeting/asset-access";
import {
  canUserReadWhiteboardDocument,
  isWhiteboardRoomIdentity,
  resolveOpenMeetingPresentingWhiteboard,
  resolveMeetingIdForWhiteboardConnection,
} from "@/modules/whiteboards/server/documents";
import { verifyGuestAdmissionBySecret } from "@/modules/meetings/server/access/guest-admission";
import { getGuestCookieSecretFromCookie } from "@/platform/http/cookies.server";
import { enforceWhiteboardAssetRateLimit } from "@/platform/http/rate-limit.server";

/**
 * A revision's assets are readable by whoever may read the history of a
 * Meeting that shows the revision: the Meeting that captured it, and any later
 * Meeting whose unchanged board reused it as its own capture. Asking only the
 * first left a reusing Meeting's attendees with its shapes but not its images.
 */
async function canUserReadWhiteboardRevisionAsset(
  db: ReturnType<typeof createDb>,
  input: {
    revisionId: string;
    whiteboardId: string;
    key: string;
    userId: string;
  },
): Promise<boolean> {
  const revision = await db.query.whiteboardRevisions.findFirst({
    where: { id: input.revisionId, whiteboardId: input.whiteboardId },
    columns: { assetManifest: true, sourceMeetingId: true },
  });
  if (!revision?.assetManifest) return false;
  let manifest: unknown;
  try {
    manifest = JSON.parse(revision.assetManifest);
  } catch {
    return false;
  }
  if (!Array.isArray(manifest) || !manifest.includes(input.key)) return false;

  const capturing = await db
    .select({ meetingId: meetingWhiteboards.meetingId })
    .from(meetingWhiteboards)
    .where(and(
      eq(meetingWhiteboards.capturedRevisionId, input.revisionId),
      eq(meetingWhiteboards.whiteboardId, input.whiteboardId),
    ));
  const meetingIds = new Set(capturing.map((usage) => usage.meetingId));
  if (revision.sourceMeetingId) meetingIds.add(revision.sourceMeetingId);
  for (const meetingId of meetingIds) {
    if (await canAccessMeetingHistory(db, meetingId, input.userId)) return true;
  }
  return false;
}

async function canGuestReadWhiteboardRevisionAsset(
  db: ReturnType<typeof createDb>,
  input: {
    meetingId: string;
    admissionId: string;
    guestSecret: string;
    revisionId: string;
    whiteboardId: string;
    key: string;
  },
): Promise<boolean> {
  const admission = await verifyGuestAdmissionBySecret(
    db,
    input.meetingId,
    input.admissionId,
    input.guestSecret,
  ).catch(() => null);
  if (!admission) return false;
  const [revision] = await db
    .select({ assetManifest: whiteboardRevisions.assetManifest })
    .from(meetingWhiteboards)
    .innerJoin(
      whiteboardRevisions,
      eq(whiteboardRevisions.id, meetingWhiteboards.capturedRevisionId),
    )
    .where(
      and(
        eq(meetingWhiteboards.meetingId, input.meetingId),
        eq(meetingWhiteboards.whiteboardId, input.whiteboardId),
        eq(meetingWhiteboards.capturedRevisionId, input.revisionId),
      ),
    )
    .limit(1);
  if (!revision?.assetManifest) return false;
  try {
    const manifest: unknown = JSON.parse(revision.assetManifest);
    return Array.isArray(manifest) && manifest.includes(input.key);
  } catch {
    return false;
  }
}

/**
 * Whether a conditional R2 read returned the object itself or only its
 * metadata. `onlyIf` yields a bodyless `R2Object` when the condition fails,
 * which is the hit this endpoint answers with a 304.
 */
function hasBody(object: R2ObjectBody | R2Object): object is R2ObjectBody {
  return "body" in object;
}

// Both namespaces this endpoint serves — `whiteboards/<id>/assets/…` document
// assets and migrated `uploads/…` keys — are write-once. Uploads and PDF
// imports reserve a fresh id per object, nothing promotes new bytes over an
// existing final key, and deletion removes access rather than mutating bytes,
// so bytes at a served key cannot go stale. Caching them is what took a cold
// board open off an uncached asset path (measured: 8 requests x ~1.5s), and
// that win is the reason this lifetime exists at all.
//
// Immutable *bytes* are not an immutable *audience*, though. Authorization
// here is per viewer — session, meeting history, guest credentials — and it
// changes: a guest is removed, a Space membership ends, a file is deleted.
// `immutable` forbids revalidation outright, so a 30-day lifetime kept serving
// a revoked viewer their board images for a month with nothing reaching the
// Worker to say no.
//
// The lifetime is therefore pinned to the grant that authorized it: one hour,
// the whiteboard JWT's own lifetime, the same bound
// `WHITEBOARD_ASSET_COOKIE_MAX_AGE` already uses. A cached response never
// outlives the credential it was served under. This costs almost nothing the
// `Vary` below was not already costing — when the token rotates, the cache key
// changes and the old entry is unreachable regardless, so the previous 30 days
// were only ever reachable within a single token's life anyway. Reopening a
// board inside that hour, which is the case the measurement was about, still
// pays nothing.
//
// Past the hour the response is revalidated rather than refetched: the
// conditional R2 read below returns metadata with no body on a hit, and the
// authorization above it runs every time, which is what puts a bound on
// revocation.
const ASSET_PRIVATE_CACHE_SECONDS = 60 * 60;
const IMMUTABLE_ASSET_CACHE_CONTROL = `private, max-age=${ASSET_PRIVATE_CACHE_SECONDS}, must-revalidate`;
const PARTIAL_ASSET_CACHE_CONTROL = `private, max-age=${ASSET_PRIVATE_CACHE_SECONDS}, must-revalidate`;

// Error responses must never be cached: the registry returns 404 for a PDF
// import whose page rows land *after* the page shapes reach the canvas, and a
// sticky negative cache would resurrect the permanent-blank-page bug the
// pending-status lookup exists to prevent. Statuses alone are not enough — a
// bare 404 is heuristically eligible, so every failure names no-store itself.
const ERROR_RESPONSE_HEADERS = { "Cache-Control": "no-store" };

const SAFE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
]);

async function verifyWhiteboardAssetToken(
  request: Request,
  env: Env,
  db: ReturnType<typeof createDb>,
  whiteboardId: string,
): Promise<"allowed" | "missing" | "invalid" | "forbidden"> {
  const cookieHeader = request.headers.get("Cookie");
  const bearer = request.headers.get("Authorization");
  const bearerToken = bearer?.startsWith("Bearer ") ? bearer.slice("Bearer ".length).trim() : null;
  const requestedWhiteboardId = new URL(request.url).searchParams.get("whiteboardId");
  const cookieToken = getWhiteboardAssetTokenFromCookie(
    cookieHeader,
    requestedWhiteboardId ?? whiteboardId,
    { appUrl: env.APP_URL, environment: env.ENVIRONMENT },
  );
  const assetToken = bearerToken ?? cookieToken;

  if (!assetToken) {
    return "missing";
  }

  try {
    const claims = await verifyWhiteboardJWT(assetToken, whiteboardJwtKeyring(env));
    const syncRoomId = syncRoomIdFromWhiteboardRoomId(claims.sid);
    if (!syncRoomId) return "forbidden";
    const activeMeetingId =
      claims.service === "recorder"
        ? await resolveOpenMeetingPresentingWhiteboard(db, syncRoomId)
        : await resolveMeetingIdForWhiteboardConnection(db, syncRoomId, claims.connectionId);
    const sameDocument = activeMeetingId
      ? await isWhiteboardRoomIdentity(db, whiteboardId, syncRoomId)
      : false;
    const authorizedMeetingId = activeMeetingId;
    if (!authorizedMeetingId || !sameDocument) {
      return "forbidden";
    }
    if (claims.service === "recorder") {
      return (await canRecorderReadWhiteboardAsset(db, authorizedMeetingId))
        ? "allowed"
        : "forbidden";
    }
    return (await canActiveParticipantReadWhiteboardAsset(db, {
      meetingId: authorizedMeetingId,
      connectionId: claims.connectionId,
      participantIdentity: claims.sub,
    }))
      ? "allowed"
      : "forbidden";
  } catch {
    return "invalid";
  }
}

export async function handleWbAssets(request: Request, env: Env, key: string): Promise<Response> {
  if (!key || key.includes("..")) {
    return new Response("Not found", { headers: ERROR_RESPONSE_HEADERS, status: 404 });
  }

  // Every path below authorizes before it serves — a whiteboard token to
  // verify, a registry row to read, a meeting's history access to resolve — and
  // none of that had a route-local bound on how fast an anonymous caller could
  // ask for it.
  await enforceWhiteboardAssetRateLimit(env, request);

  const documentAsset = extractWhiteboardDocumentAssetIdentity(key);
  if (!documentAsset) {
    return new Response("Forbidden", { headers: ERROR_RESPONSE_HEADERS, status: 403 });
  }

  const bucket = env.R2_BUCKET;
  if (!bucket) {
    return new Response("Storage unavailable", { headers: ERROR_RESPONSE_HEADERS, status: 503 });
  }

  const db = createDb(env.DB);
  const revisionId = new URL(request.url).searchParams.get("revisionId");

  const requestedWhiteboardId =
    new URL(request.url).searchParams.get("whiteboardId") ?? documentAsset.whiteboardId;
  if (requestedWhiteboardId === documentAsset.whiteboardId) {
    // The owning board reads through the registry, not the key alone: a key
    // this board never registered is not this board's to serve.
    //
    // `deleting` is the status that must not serve — a rolled-back upload or
    // a requested deletion, whose bytes are on their way out. `pending` is
    // not a trust state, though it reads like one. No browser can PUT to a
    // key under this prefix: presigned uploads all target `staging/`, and the
    // server promotes them here with a validated copy, so every byte at a
    // final key was written by us. What `pending` means is "the object may
    // not be here yet", and R2 is the authority on that — it answers 404 on
    // the miss, which is the same answer for an honest reason.
    //
    // Refusing `pending` outright cost us a real bug. A PDF import commits
    // its rows at finalize, which lands *after* the page shapes reach the
    // canvas, so the page the importing user is already looking at requests
    // its image inside that window. A 404 there is permanent for the
    // session — an <img> that fails never retries — and the first imported
    // page stayed blank until a reload.
    const asset = await db.query.whiteboardAssets.findFirst({
      where: { r2Key: key, status: { in: ["pending", "committed"] } },
      columns: { id: true },
    });
    if (!asset)
      return new Response("Not found", { headers: ERROR_RESPONSE_HEADERS, status: 404 });
  } else {
    const reference = await db.query.whiteboardAssetReferences.findFirst({
      where: {
        whiteboardId: requestedWhiteboardId,
        r2Key: key,
      },
      columns: { id: true },
    });
    if (!reference)
      return new Response("Forbidden", { headers: ERROR_RESPONSE_HEADERS, status: 403 });
  }
  // A Whiteboard token proves an active session in this exact document.
  // Authenticated sessions without one fall through to history authorization.
  const tokenStatus = await verifyWhiteboardAssetToken(request, env, db, requestedWhiteboardId);

  if (tokenStatus !== "allowed") {
    const session = await verifySessionFromRawRequest(request, env);
    const requestUrl = new URL(request.url);
    const guestMeetingId = requestUrl.searchParams.get("meetingId");
    const guestAdmissionId = requestUrl.searchParams.get("admissionId");
    const guestSecret = guestAdmissionId
      ? getGuestCookieSecretFromCookie(request.headers.get("Cookie"), guestAdmissionId, {
          appUrl: env.APP_URL,
          environment: env.ENVIRONMENT,
        })
      : null;
    const hasGuestCredentials = Boolean(
      revisionId && guestMeetingId && guestAdmissionId && guestSecret,
    );
    const allowed = session
      ? revisionId
        ? await canUserReadWhiteboardRevisionAsset(db, {
            revisionId,
            whiteboardId: requestedWhiteboardId,
            key,
            userId: session.userId,
          })
        : await canUserReadWhiteboardDocument(db, requestedWhiteboardId, session.userId)
      : revisionId && guestMeetingId && guestAdmissionId && guestSecret
        ? await canGuestReadWhiteboardRevisionAsset(db, {
            meetingId: guestMeetingId,
            admissionId: guestAdmissionId,
            guestSecret,
            revisionId,
            whiteboardId: requestedWhiteboardId,
            key,
          })
        : false;
    if (!allowed) {
      if (
        !session &&
        !hasGuestCredentials &&
        (tokenStatus === "missing" || tokenStatus === "invalid")
      ) {
        return new Response("Unauthorized", { headers: ERROR_RESPONSE_HEADERS, status: 401 });
      }
      return new Response("Forbidden", { headers: ERROR_RESPONSE_HEADERS, status: 403 });
    }
  }

  const ifNoneMatch = request.headers.get("If-None-Match");
  const range = parseSingleByteRange(request.headers.get("Range"));

  const matchesIfNoneMatch = (etag: string) => {
    if (!ifNoneMatch) return false;
    if (ifNoneMatch.trim() === "*") return true;
    const normalized = etag.startsWith("W/") ? etag.slice(2) : etag;
    return [...ifNoneMatch.matchAll(/(?:W\/)?"[^"\r\n]*"/g)].some((match) => {
      const candidate = match[0];
      return (candidate.startsWith("W/") ? candidate.slice(2) : candidate) === normalized;
    });
  };
  // R2 accepts one strong ETag in its conditional API. Lists, wildcard and
  // weak validators need an explicit metadata comparison to preserve HTTP's
  // weak comparison semantics without sending the object body.
  const r2ConditionalEtag =
    ifNoneMatch && /^"[^"\r\n]*"$/.test(ifNoneMatch.trim()) ? ifNoneMatch.trim() : null;
  // R2 takes the bare ETag value and throws on the quoted HTTP form, so
  // every browser revalidation of a cached image used to answer 500.
  const r2EtagValue = r2ConditionalEtag?.slice(1, -1) ?? null;

  // A revalidation asks one question — "are these still the bytes I have?" —
  // and `onlyIf` is what lets R2 answer it without shipping the object. Reading
  // unconditionally and comparing the ETag afterwards paid for the whole body
  // on every 304, which is most of a cache miss: exactly the cost the cache
  // above exists to avoid, spent precisely when the cache was working.
  let object: R2ObjectBody | R2Object | null;
  try {
    object = range
      ? await bucket.get(key, { range })
      : r2EtagValue !== null
        ? await bucket.get(key, { onlyIf: { etagDoesNotMatch: r2EtagValue } })
        : ifNoneMatch
          ? await bucket.head(key)
          : await bucket.get(key);
  } catch (error) {
    if (!range || !isR2RangeError(error)) throw error;
    // R2 rejects ranges that start beyond the object. Report the full size so
    // the media element can recover instead of failing the whole load.
    const head = await bucket.head(key).catch(() => null);
    const headers = new Headers({ "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
    if (head) headers.set("Content-Range", `bytes */${head.size}`);
    return new Response("Range not satisfiable", { status: 416, headers });
  }
  if (!object) {
    return new Response("Not found", { headers: ERROR_RESPONSE_HEADERS, status: 404 });
  }

  // No body means R2 refused the conditional read: the ETag matched, so the
  // caller's copy is current. A ranged request never takes the conditional
  // path, so it still compares explicitly.
  // A bodyless conditional GET means R2 rejected the read because its ETag
  // matched. A HEAD response is always bodyless, so complex validators must
  // be compared explicitly instead of treating the missing body as a match.
  const isUnchanged = r2ConditionalEtag ? !hasBody(object) : matchesIfNoneMatch(object.httpEtag);
  if (ifNoneMatch && isUnchanged) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: object.httpEtag,
        "Cache-Control": IMMUTABLE_ASSET_CACHE_CONTROL,
        Vary: "Cookie, Authorization",
      },
    });
  }

  // A complex validator needed a HEAD above. It did not match, so fetch the
  // body only now; common single-ETag revalidation still takes one R2 request.
  if (!range && ifNoneMatch && !r2ConditionalEtag && !hasBody(object)) {
    object = await bucket.get(key);
    if (!object || !hasBody(object)) {
      return new Response("Not found", { headers: ERROR_RESPONSE_HEADERS, status: 404 });
    }
  }
  // Every path below streams bytes, which only an object carrying a body can
  // do. Unreachable in practice — a bodyless result is always the 304 above —
  // but the narrowing has to be explicit rather than asserted.
  if (!hasBody(object)) {
    return new Response("Not found", { headers: ERROR_RESPONSE_HEADERS, status: 404 });
  }

  const rawType = object.httpMetadata?.contentType ?? "application/octet-stream";
  const contentType = SAFE_CONTENT_TYPES.has(rawType) ? rawType : "application/octet-stream";

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  // `immutable` is a promise about the whole representation, so it belongs only
  // on a full-body response. A partial one describes the bytes a single Range
  // asked for, and the cache key does not vary on Range.
  headers.set("Cache-Control", range ? PARTIAL_ASSET_CACHE_CONTROL : IMMUTABLE_ASSET_CACHE_CONTROL);
  headers.set("Vary", "Cookie, Authorization");
  headers.set("Accept-Ranges", "bytes");

  if (object.httpEtag) {
    headers.set("ETag", object.httpEtag);
  }
  if (object.uploaded instanceof Date) {
    headers.set("Last-Modified", object.uploaded.toUTCString());
  }

  if (range) {
    const satisfied = satisfiedRange(range, object.size);
    headers.set("Content-Length", String(satisfied.length));
    headers.set(
      "Content-Range",
      `bytes ${satisfied.offset}-${satisfied.offset + satisfied.length - 1}/${object.size}`,
    );
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

// R2's InvalidRange failure (error code 10039, "requested range is not
// satisfiable") surfaces from the Workers binding as a thrown Error whose
// message carries the code. Only that failure maps to a 416 — a transient R2
// error on a ranged request must stay a 5xx so media elements retry instead of
// treating the asset as permanently broken.
function isR2RangeError(error: unknown): boolean {
  return error instanceof Error && /\(10039\)|invalid range|not satisfiable/i.test(error.message);
}

type SingleByteRange = { offset: number; length?: number } | { suffix: number };

// Parses a single `bytes=` range into the R2Range shapes the Workers API
// accepts (offset+optional length, or suffix). Multi-range and malformed
// headers return null and the full object is served — RFC 9110 permits
// ignoring Range. If-Range is not evaluated: whiteboard upload keys are
// write-once, so the ranged bytes cannot belong to a different version.
function parseSingleByteRange(header: string | null): SingleByteRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;

  if (startRaw === "") {
    const suffix = Number(endRaw);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { suffix } : null;
  }

  const offset = Number(startRaw);
  if (!Number.isSafeInteger(offset)) return null;
  if (endRaw === "") return { offset };

  const end = Number(endRaw);
  if (!Number.isSafeInteger(end) || end < offset) return null;
  return { offset, length: end - offset + 1 };
}

// The byte window R2 actually returned for a request that succeeded: R2 clamps
// ranges extending past the object to the available bytes.
function satisfiedRange(range: SingleByteRange, size: number): { offset: number; length: number } {
  if ("suffix" in range) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const maxLength = size - range.offset;
  return {
    offset: range.offset,
    length: Math.min(range.length ?? maxLength, maxLength),
  };
}

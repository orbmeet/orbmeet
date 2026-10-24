import { MEETING_CODE_SOURCE } from "@/modules/meetings/contract/constants";

export const DEFAULT_AUTH_REDIRECT = "/home";

const INTERNAL_ORIGIN = "https://internal.orbmeet.invalid";
const MEETING_CODE_PATH = `(?:${MEETING_CODE_SOURCE})`;
const ALLOWED_REDIRECT_PATHS = [
  /^\/home\/?$/,
  /^\/meetings\/?$/,
  /^\/meetings\/meeting_[0-7][0-9abcdefghjkmnpqrstvwxyz]{25}\/?$/,
  /^\/settings\/?$/,
  /^\/spaces\/?$/,
  /^\/whiteboards\/?$/,
  /^\/whiteboards\/whiteboard_[0-7][0-9abcdefghjkmnpqrstvwxyz]{25}\/?$/,
  /^\/space\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/,
  /^\/join\/[a-zA-Z]{8}\/?$/,
  new RegExp(`^/${MEETING_CODE_PATH}$`),
] as const;

function parseInternalRedirect(value: string): URL | undefined {
  if (!value.startsWith("/") || value.startsWith("//")) return undefined;
  try {
    const url = new URL(value, INTERNAL_ORIGIN);
    return url.origin === INTERNAL_ORIGIN ? url : undefined;
  } catch {
    return undefined;
  }
}

export function isSafeInternalRedirect(value: string): boolean {
  const url = parseInternalRedirect(value);
  return Boolean(url && ALLOWED_REDIRECT_PATHS.some((pattern) => pattern.test(url.pathname)));
}

export function sanitizeInternalRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const url = parseInternalRedirect(value);
  if (!url || !ALLOWED_REDIRECT_PATHS.some((pattern) => pattern.test(url.pathname))) {
    return undefined;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function resolveAuthRedirect(value: unknown): string {
  return sanitizeInternalRedirect(value) ?? DEFAULT_AUTH_REDIRECT;
}

/** A validated internal redirect encoded for an RFC 6265 cookie value. */
export function encodeAuthRedirectCookieValue(value: unknown): string | undefined {
  const redirect = sanitizeInternalRedirect(value);
  return redirect === undefined ? undefined : encodeURIComponent(redirect);
}

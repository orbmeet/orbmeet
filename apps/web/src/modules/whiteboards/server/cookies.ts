import {
  type CookieOptions,
  createCookieString,
  appendCookies,
  getCookieValue,
} from "@/platform/http/cookies.server";

const WHITEBOARD_ASSET_COOKIE_MAX_AGE = 60 * 60; // 1 hour — aligned with the default WB JWT lifetime
const WHITEBOARD_ASSET_COOKIE_PATH = "/api/wb-assets/";

function whiteboardAssetCookieName(meetingId: string): string {
  return `wb_asset_${meetingId}`;
}

export function createWhiteboardAssetCookieString(
  meetingId: string,
  token: string,
  maxAge = WHITEBOARD_ASSET_COOKIE_MAX_AGE,
  options?: CookieOptions,
): string {
  return createCookieString(
    whiteboardAssetCookieName(meetingId),
    token,
    maxAge,
    { ...options, path: WHITEBOARD_ASSET_COOKIE_PATH },
  );
}

export function getWhiteboardAssetTokenFromCookie(
  cookie: string | null,
  meetingId: string,
  options?: CookieOptions,
): string | null {
  return getCookieValue(cookie, whiteboardAssetCookieName(meetingId), {
    ...options,
    path: WHITEBOARD_ASSET_COOKIE_PATH,
  });
}

function setWhiteboardAssetCookie(
  meetingId: string,
  token: string,
  options?: CookieOptions
): void {
  try {
    const cookieStr = createWhiteboardAssetCookieString(
      meetingId,
      token,
      WHITEBOARD_ASSET_COOKIE_MAX_AGE,
      options,
    );
    appendCookies([cookieStr]);
  } catch {
    // Direct unit tests may call token issuance helpers without a response context.
  }
}

export function setWhiteboardAssetCookies(
  scopeIds: string[],
  token: string,
  options?: CookieOptions,
): void {
  for (const scopeId of new Set(scopeIds.filter(Boolean))) {
    setWhiteboardAssetCookie(scopeId, token, options);
  }
}

export function clearWhiteboardAssetCookie(
  meetingId: string,
  options?: CookieOptions
): void {
  try {
    const cookieStr = createWhiteboardAssetCookieString(
      meetingId,
      "",
      0,
      options,
    );
    appendCookies([cookieStr]);
  } catch {
  }
}

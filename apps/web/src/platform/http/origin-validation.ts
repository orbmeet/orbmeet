import { logWarn } from "@/lib/logger";
import { isLocalDevelopment, type Deployment } from "./deployment";

/**
 * Validate request origin for CSRF/WebSocket security
 */
export function validateOrigin(
  request: Request,
  options: Deployment = {}
): boolean {
  if (isLocalDevelopment(options)) return true;
  const { appUrl } = options;

  const origin = request.headers.get("Origin");
  const referer = request.headers.get("Referer");
  const detectedOrigin = origin || (referer ? getOriginFromUrl(referer) : null);

  // Fail closed if APP_URL not configured
  if (!appUrl) {
    logWarn("[OriginValidation] REJECTED: Missing APP_URL in production");
    return false;
  }

  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(appUrl).origin;
  } catch {
    logWarn("[OriginValidation] REJECTED: Invalid APP_URL in production");
    return false;
  }

  if (!detectedOrigin) {
    // Sec-Fetch-Site is a browser-only forbidden header — non-browser
    // clients can set it freely. Require Origin or Referer for all mutations.
    logWarn(
      "[OriginValidation] REJECTED: Missing Origin/Referer in production"
    );
    return false;
  }

  // Only accept exact app origin for CSRF protection.
  // Trusted subdomains (livekit, whiteboard) should use server secrets
  // for service-to-service calls, not CSRF origin trust.
  if (detectedOrigin === expectedOrigin) {
    return true;
  }

  logWarn(
    `[OriginValidation] REJECTED: Origin mismatch (expected: ${expectedOrigin}, got: ${detectedOrigin})`
  );
  return false;
}

function getOriginFromUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Validate CSRF origin for mutating requests
 */
export function validateCsrfOrigin(
  request: Request,
  options: Deployment = {}
): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }
  return validateOrigin(request, options);
}

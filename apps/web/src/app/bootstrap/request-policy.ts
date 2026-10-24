// What the Worker decides about a request before any handler runs: whether
// the deployment is fit to serve, which API paths are exempt from the browser
// CSRF gate, and the security policy a document is answered with. Kept free of
// Start and the database so the Worker entry can read it without loading
// either.
import { isMeetingDocumentPath } from "@/modules/meetings/contract/paths";
import { whiteboardCspDomains, type SecurityHeadersConfig } from "@/platform/http/csp";
import { deploymentOf, isLocalDevelopment } from "@/platform/http/deployment";
import { mediaNodeHosts } from "@/platform/realtime/nodes";

/** A developer's own run; see `isLocalDevelopment`. */
export function isDevelopment(env: Env | undefined): boolean {
  return isLocalDevelopment(deploymentOf(env));
}

/** Whether responses may pin browsers to HTTPS. */
export function enablesHsts(env: Env | undefined): boolean {
  return !isDevelopment(env) && env?.APP_URL?.startsWith("https://") === true;
}

/** A production deployment missing what it cannot run safely without, as the response to send. */
export function validateProductionConfig(env: Env | undefined): Response | null {
  if (!env || isDevelopment(env)) return null;
  if (!env?.APP_URL) {
    return new Response("Server misconfiguration: APP_URL is required in production", { status: 500 });
  }
  try {
    const url = new URL(env.APP_URL);
    if (url.protocol !== "https:") {
      return new Response("Server misconfiguration: APP_URL must be https in production", { status: 500 });
    }
  } catch {
    return new Response("Server misconfiguration: APP_URL is invalid in production", { status: 500 });
  }
  const authSecret = env.AUTH_SECRET?.trim() ?? "";
  const normalizedSecret = authSecret.toLowerCase();
  if (
    authSecret.length < 32
    || normalizedSecret.includes("your-auth-secret")
    || normalizedSecret.includes("placeholder")
    || normalizedSecret.includes("change-me")
  ) {
    return new Response(
      "Server misconfiguration: AUTH_SECRET must be at least 32 random characters",
      { status: 500 },
    );
  }
  return null;
}

export function isAutomationApiPath(pathname: string): boolean {
  return pathname === "/api/v1/me"
    || pathname === "/api/v1/targets"
    || pathname === "/api/v1/meetings"
    || pathname === "/api/v1/meetings/"
    || pathname === "/api/v1/schedules"
    || pathname === "/api/v1/schedules/"
    || /^\/api\/v1\/schedules\/[^/]+$/.test(pathname);
}

/**
 * Mutation endpoints authenticated without browser cookies must not require an
 * Origin header. Keep this allowlist exact: every other dynamic mutation is a
 * browser surface and remains protected by the global CSRF gate.
 */
export function isCsrfExemptApiPath(pathname: string): boolean {
  return pathname === "/api/livekit/webhook"
    || pathname === "/api/billing/webhook"
    || pathname === "/api/internal/transcripts"
    || pathname === "/api/email/unsubscribe"
    || isAutomationApiPath(pathname);
}

/**
 * The security policy for an application document at `pathname`: a meeting
 * may use the camera and signal to every media node, and any document may
 * client-navigate into a Whiteboard, so each admits the sync server.
 */
export function documentSecurityConfig(env: Env | undefined, pathname: string): SecurityHeadersConfig {
  return {
    enableHSTS: enablesHsts(env),
    isDevelopment: isDevelopment(env),
    isMeetRoute: isMeetingDocumentPath(pathname),
    appUrl: env?.APP_URL,
    mediaNodeHosts: env ? mediaNodeHosts(env) : [],
    addonCspDomains: whiteboardCspDomains(env?.APP_URL),
  };
}

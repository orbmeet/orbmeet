import "@tanstack/react-start/server-only";

import { getRequest } from "@tanstack/react-start/server";
import { readCloudflareContext } from "@/platform/runtime/cloudflare-context";
import {
  type CookieOptions,
  appendCookies,
  createCookieString,
  getGuestCookieSecretFromCookie,
} from "@/platform/http/cookies.server";

/**
 * A guest's cookie proves one admission to one meeting, and a guest has no
 * in-app way back to a meeting once they leave it. Every admission sets its
 * own cookie, so a long lifetime only piles them up in the Cookie header of
 * someone who joins many meetings. A day outlasts any ordinary meeting and
 * its closing capture; a guest still there after it rejoins as a new
 * admission.
 */
const GUEST_COOKIE_MAX_AGE = 24 * 60 * 60;

function guestCookieName(admissionId: string): string {
  return `guest_${admissionId}`;
}

export function getGuestCookieSecret(admissionId: string): string | null {
  try {
    const env = readCloudflareContext()?.env;
    return getGuestCookieSecretFromCookie(
      getRequest().headers.get("Cookie"),
      admissionId,
      env ? { appUrl: env.APP_URL, environment: env.ENVIRONMENT } : undefined,
    );
  } catch {
    return null;
  }
}

export function setGuestCookie(
  admissionId: string,
  rawSecret: string,
  options?: CookieOptions,
): void {
  appendCookies([
    createCookieString(guestCookieName(admissionId), rawSecret, GUEST_COOKIE_MAX_AGE, options),
  ]);
}

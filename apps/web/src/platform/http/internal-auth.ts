import {
  SIGNATURE_HEADER,
  signatureTarget,
  signRequest,
  verifySignedRequest,
  type Keyring,
} from "@orbmeet/primitives";
import { logError, logWarn } from "@/lib/logger";
import {
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
  readRequestBodyText,
} from "./request-body";

/**
 * Service-to-service authentication.
 *
 * Every internal link is signed with a keyring (a JSON map of key ids to
 * secrets, see `@orbmeet/primitives`' `signed-request`). Each direction has
 * its own keyring, so the key a peer holds to call the Worker cannot sign the
 * Worker's calls to it. This module is the Worker's one place to read, verify
 * and produce those signatures.
 */

export type SignedRequestResult =
  | { ok: true; body: string; keyId: string }
  | { ok: false; response: Response };

/** Read a signed request's body and verify it against `keyring`. */
export async function readSignedRequest(
  request: Request,
  keyring: Keyring | null,
  maxBodyBytes: number,
): Promise<SignedRequestResult> {
  if (!keyring) {
    return { ok: false, response: new Response("Service unavailable", { status: 503 }) };
  }
  let body: string;
  try {
    body = await readRequestBodyText(request, maxBodyBytes);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { ok: false, response: new Response("Payload too large", { status: 413 }) };
    }
    if (error instanceof RequestBodyTimeoutError) {
      return { ok: false, response: new Response("Request timeout", { status: 408 }) };
    }
    throw error;
  }
  const verification = await verifySignedRequest({
    header: request.headers.get(SIGNATURE_HEADER),
    method: request.method,
    target: signatureTarget(request.url),
    body,
    keyring,
  });
  if (!verification.ok) {
    // A well-formed signature under a key this Worker does not hold, or from
    // a clock that has drifted, is a peer of ours misconfigured (a keyring
    // rotated on one side only), and its requests are lost until it is fixed.
    // Anything else may be anyone on the internet.
    const path = new URL(request.url).pathname;
    const { reason } = verification;
    if (reason === "unknown_key" || reason === "expired") {
      logError("[internal-auth] Refused a peer's signature", { path, reason });
    } else {
      logWarn("[internal-auth] Refused an internal request's signature", { path, reason });
    }
    return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
  }
  return { ok: true, body, keyId: verification.keyId };
}

/** A signed JSON POST from the Worker to a peer service. */
export async function postSignedJson(
  url: string,
  body: unknown,
  keyring: Keyring,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  const text = JSON.stringify(body);
  return fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      [SIGNATURE_HEADER]: await signRequest({
        method: "POST",
        target: signatureTarget(url),
        body: text,
        keyring,
      }),
    },
    body: text,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

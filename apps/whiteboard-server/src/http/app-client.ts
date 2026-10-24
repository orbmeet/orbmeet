import {
  SIGNATURE_HEADER,
  signatureTarget,
  signRequest,
  type Keyring,
} from "@orbmeet/primitives";
import { SYNC_PROTOCOL, SYNC_PROTOCOL_HEADER } from "@orbmeet/whiteboard-core/sync-commands";

/**
 * The sync server's calls to the app Worker, signed with the callback keyring
 * (`WHITEBOARD_CALLBACK_KEYS`). The Worker's commands to this server use a
 * separate keyring, so neither direction's key can forge the other. Each
 * states the sync protocol it speaks, which the Worker checks it accepts.
 */
export async function postSignedJson(
  url: string | URL,
  body: unknown,
  keyring: Keyring,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const target = typeof url === "string" ? new URL(url) : url;
  const text = JSON.stringify(body);
  return fetchImpl(target.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL.speaks),
      [SIGNATURE_HEADER]: await signRequest({
        method: "POST",
        target: signatureTarget(target),
        body: text,
        keyring,
      }),
    },
    body: text,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

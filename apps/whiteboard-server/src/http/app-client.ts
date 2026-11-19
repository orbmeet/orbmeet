import { postSignedJson, type Keyring } from "@orbmeet/primitives";
import { SYNC_PROTOCOL, SYNC_PROTOCOL_HEADER } from "@orbmeet/whiteboard-core/sync-commands";

/**
 * The sync server's calls to the app Worker, signed with the callback keyring
 * (`WHITEBOARD_CALLBACK_KEYS`). The Worker's commands to this server use a
 * separate keyring, so neither direction's key can forge the other. Each
 * states the sync protocol it speaks, which the Worker checks it accepts.
 */
export function postToApp(
  url: string | URL,
  body: unknown,
  keyring: Keyring,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return postSignedJson(url, body, keyring, {
    timeoutMs,
    fetch: fetchImpl,
    headers: { [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL.speaks) },
  });
}

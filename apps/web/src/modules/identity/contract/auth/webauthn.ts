/**
 * Pure WebAuthn credential-shape helpers shared by the passkey RPC validators
 * and their server implementations. They live in the contract layer so the
 * RPC declaration files (whose validators must resolve in the browser graph)
 * can use them without reaching into server implementation modules.
 */

import { MAX_PASSKEY_CREDENTIAL_ID_LENGTH } from "@orbmeet/domain-model";

export function hasValidCredentialId(response: unknown): response is { id: string } {
  if (!response || typeof response !== "object") return false;
  const id = (response as { id?: unknown }).id;
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_PASSKEY_CREDENTIAL_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(id)
  );
}

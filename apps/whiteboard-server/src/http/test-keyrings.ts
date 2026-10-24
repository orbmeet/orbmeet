// Keyrings for tests. Never used outside `*.test.ts`.
import { parseKeyring, type Keyring } from "@orbmeet/primitives";

function keyring(entries: Record<string, string>): Keyring {
  const parsed = parseKeyring(JSON.stringify(entries));
  if (!parsed) throw new Error("invalid test keyring");
  return parsed;
}

export const TEST_COMMAND_KEYRING = keyring({ cmd1: "c".repeat(40) });
export const TEST_CALLBACK_KEYRING = keyring({ cb1: "b".repeat(40) });
export const TEST_JWT_KEYRING = keyring({ jwt1: "j".repeat(40) });

import type { Database } from "@orbmeet/db";
import { verifications } from "@orbmeet/db/schema";
import { and, eq, gte } from "drizzle-orm";
export {
  isPasskeyChallengeId,
  PASSKEY_USER_VERIFICATION,
  REQUIRE_PASSKEY_USER_VERIFICATION,
} from "@/modules/identity/contract/auth/passkey-policy";

export async function consumePasskeyChallenge(
  db: Database,
  type: "passkey_register" | "passkey_auth",
  identifier: string,
  now = new Date(),
) {
  const consumed = await db
    .delete(verifications)
    .where(
      and(
        eq(verifications.type, type),
        eq(verifications.identifier, identifier),
        gte(verifications.expiresAt, now),
      ),
    )
    .returning();

  return consumed[0] ?? null;
}

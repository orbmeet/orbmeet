import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { verifications } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import {
  MAX_ACTIVE_PASSKEY_AUTH_CHALLENGES,
  MAX_ACTIVE_PASSKEY_AUTH_CHALLENGES_PER_SOURCE,
} from "./passkey.server";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

/**
 * The admission gate `startPasskeyAuthentication` runs, in isolation from the
 * server-function plumbing around it. Passkey sign-in has to be startable
 * before anyone is authenticated, so this predicate is the whole defence.
 */
async function admitChallenge(id: string, source: string, nowSeconds: number) {
  const result = await db.run(sql`
    insert into ${verifications} (
      id, type, identifier, value, data, expires_at, created_at, updated_at
    )
    select
      ${id}, 'passkey_auth', ${`passkey-auth:${id}`}, ${`challenge-${id}`},
      ${JSON.stringify({ source })}, ${nowSeconds + 600}, ${nowSeconds}, ${nowSeconds}
    where (
      select count(*) from ${verifications}
      where ${verifications.type} = 'passkey_auth'
        and ${verifications.expiresAt} > ${nowSeconds}
    ) < ${MAX_ACTIVE_PASSKEY_AUTH_CHALLENGES}
    and (
      select count(*) from ${verifications}
      where ${verifications.type} = 'passkey_auth'
        and ${verifications.expiresAt} > ${nowSeconds}
        and json_extract(${verifications.data}, '$.source') = ${source}
    ) < ${MAX_ACTIVE_PASSKEY_AUTH_CHALLENGES_PER_SOURCE}
  `);
  return (result.meta?.changes ?? 0) > 0;
}

describe("passkey authentication challenge pool", () => {
  it("stops one source at its own share instead of the whole pool", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (let index = 0; index < MAX_ACTIVE_PASSKEY_AUTH_CHALLENGES_PER_SOURCE; index += 1) {
      await expect(admitChallenge(`flood_${index}`, "source_a", nowSeconds)).resolves.toBe(true);
    }

    // The flooding source is done…
    await expect(admitChallenge("flood_extra", "source_a", nowSeconds)).resolves.toBe(false);
    // …and everyone else is unaffected, with nothing of theirs evicted.
    await expect(admitChallenge("other", "source_b", nowSeconds)).resolves.toBe(true);

    const held = await db
      .select({ count: sql<number>`count(*)` })
      .from(verifications)
      .where(and(eq(verifications.type, "passkey_auth")));
    expect(held[0]?.count).toBe(MAX_ACTIVE_PASSKEY_AUTH_CHALLENGES_PER_SOURCE + 1);
  });

  it("does not count another source's challenges against a caller", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (let index = 0; index < 5; index += 1) {
      await admitChallenge(`a_${index}`, "source_a", nowSeconds);
    }
    for (let index = 0; index < 5; index += 1) {
      await expect(admitChallenge(`b_${index}`, "source_b", nowSeconds)).resolves.toBe(true);
    }
  });

  it("frees a source's share as its challenges expire", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (let index = 0; index < MAX_ACTIVE_PASSKEY_AUTH_CHALLENGES_PER_SOURCE; index += 1) {
      await admitChallenge(`expiring_${index}`, "source_a", nowSeconds);
    }
    await expect(admitChallenge("blocked", "source_a", nowSeconds)).resolves.toBe(false);

    // Ten minutes later every one of those has expired.
    await expect(admitChallenge("later", "source_a", nowSeconds + 601)).resolves.toBe(true);
  });
});

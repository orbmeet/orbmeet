import { beforeEach, describe, expect, it } from "vitest";
import { spaces, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace, seedSharedSpace } from "@/test/fixtures";
import {
  getPersonalSpaceTranscriptionImpl,
  manageableSpaceTranscription,
  setSpaceTranscriptionImpl,
} from "./transcription.server";

// Meeting defaults come from the Space, never from whoever opens it: its
// admins set whether its meetings begin transcribed.

let db: TestDb;
const env = { RATE_LIMITER: { limit: async () => ({ success: true }) } } as unknown as Env;
const contextFor = (userId: string) => ({ user: { id: userId, name: userId }, db, env }) as unknown as AuthFnContext;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date("2026-11-01T10:00:00.000Z");
  for (const id of ["admin", "member"]) {
    await db.insert(users).values({
      id,
      name: id,
      email: `${id}@example.com`,
      normalizedEmail: `${id}@example.com`,
      role: "user",
      createdAt: now,
      updatedAt: now,
    });
  }
  await seedSharedSpace(db, {
    id: "team",
    ownerUserId: "admin",
    now,
    members: [{ userId: "admin", role: "owner" }, { userId: "member" }],
  });
});

async function teamDefault(): Promise<boolean | undefined> {
  return (await db.query.spaces.findFirst({ where: { id: "team" }, columns: { transcribeMeetings: true } }))
    ?.transcribeMeetings;
}

describe("a Space's transcription default", () => {
  it("begins on, and is changed by the Space's admins", async () => {
    expect(await teamDefault()).toBe(true);

    await expect(setSpaceTranscriptionImpl({ data: { spaceId: "team", on: false }, context: contextFor("admin") }))
      .resolves.toEqual({ spaceId: "team", on: false });
    expect(await teamDefault()).toBe(false);
  });

  it("is refused to a member who does not manage the Space", async () => {
    await expect(setSpaceTranscriptionImpl({ data: { spaceId: "team", on: false }, context: contextFor("member") }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await teamDefault()).toBe(true);
  });

  it("is offered in a meeting only to someone who may change it", async () => {
    await expect(manageableSpaceTranscription(db, "team", "admin")).resolves.toEqual({ spaceId: "team", on: true });
    await expect(manageableSpaceTranscription(db, "team", "member")).resolves.toBeNull();
  });

  it("is the personal Space's own for the meetings on a person's own link", async () => {
    const spaceId = await seedPersonalSpace(db, "member");
    await db.update(spaces).set({ transcribeMeetings: false }).where(eq(spaces.id, spaceId));

    await expect(getPersonalSpaceTranscriptionImpl({ context: contextFor("member") }))
      .resolves.toEqual({ spaceId, on: false });
    await expect(setSpaceTranscriptionImpl({ data: { spaceId, on: true }, context: contextFor("member") }))
      .resolves.toEqual({ spaceId, on: true });
  });
});

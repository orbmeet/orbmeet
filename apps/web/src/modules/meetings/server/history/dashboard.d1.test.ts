import { beforeEach, describe, expect, it } from "vitest";
import { meetingLinks, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { insertMeetingForLinkWithinLimit } from "../lifecycle/meeting-occurrence";
import {
  archiveMeetingLinkIfIdle,
  archiveMeetingLinkImpl,
  updateMeetingLinkImpl,
} from "@/modules/meetings/server/history/dashboard.server";
import type { AuthFnContext } from "@/app/bootstrap/middleware";

let db: TestDb;
const appDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date("2026-08-03T10:00:00.000Z");
  await db.insert(users).values({
    id: "host",
    name: "Host",
    email: "host@example.com",
    normalizedEmail: "host@example.com",
    plan: "pro",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
  await seedPersonalSpace(appDb(), "host", { now });
  await db.insert(meetingLinks).values({
    id: "personal_room",
    code: "abc-defg-hij",
    reusePolicy: "reusable",
    spaceId: "host_space",
    spaceKind: "personal",
    title: null,
    allowGuests: true,
    joinPolicy: "open",
    createdAt: now,
    updatedAt: now,
  });
});

describe("archiveMeetingLinkIfIdle", () => {
  it("archives an idle personal reusable link", async () => {
    const archivedAt = new Date("2026-08-03T10:05:00.000Z");

    await expect(
      archiveMeetingLinkIfIdle(appDb(), "personal_room", "host_space", archivedAt),
    ).resolves.toBe(true);
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: "personal_room" } }),
    ).resolves.toMatchObject({ archivedAt });
  });

  it("atomically refuses to archive a link with an open meeting", async () => {
    const startedAt = new Date("2026-08-03T10:04:00.000Z");
    await expect(
      insertMeetingForLinkWithinLimit(appDb(), {
        meetingId: "open_meeting",
        meetingLinkId: "personal_room",
        title: null,
        startedByUserId: "host",
        billingPrincipal: { type: "user", id: "host" },
        billingPlan: "pro",
        spaceId: "host_space",
        spaceKind: "personal",
        allowGuests: true,
        recordingEnabled: true,
        joinPolicy: "open",
        startedAt,
        linkExpiresAt: null,
        maxConcurrentMeetings: 1,
      }),
    ).resolves.toBe(true);

    await expect(
      archiveMeetingLinkIfIdle(
        appDb(),
        "personal_room",
        "host_space",
        new Date("2026-08-03T10:05:00.000Z"),
      ),
    ).resolves.toBe(false);
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: "personal_room" } }),
    ).resolves.toMatchObject({ archivedAt: null });
  });
});

describe("an account without a personal Space", () => {
  it("has no meeting links to update or archive", async () => {
    const now = new Date("2026-08-03T10:00:00.000Z");
    await db.insert(users).values({
      id: "newcomer",
      name: "Newcomer",
      email: "newcomer@example.com",
      normalizedEmail: "newcomer@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    });
    const context = {
      user: { id: "newcomer" },
      env: { RATE_LIMITER: { limit: async () => ({ success: true }) } },
      db: appDb(),
    } as unknown as AuthFnContext;

    await expect(updateMeetingLinkImpl({
      data: { meetingLinkId: "personal_room", title: "Mine now" },
      context,
    })).rejects.toThrow("Meeting link not found");
    await expect(archiveMeetingLinkImpl({
      data: { meetingLinkId: "personal_room" },
      context,
    })).rejects.toThrow("Meeting link not found");
    await expect(
      db.query.meetingLinks.findFirst({ where: { id: "personal_room" } }),
    ).resolves.toMatchObject({ title: null, archivedAt: null });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingLinks, spaceMembers, spaces, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import {ensureSpaceDefaultMeetingLink} from "@/modules/meetings/server/space-default-meeting-link.server";
import { acquireMeetingOccurrence, insertMeetingForLinkWithinLimit } from "./lifecycle/meeting-occurrence";
import { spaceRoleFor } from "./runtime/client.server";
import { finalizeMeetingEnd } from "./lifecycle/finalize";

describe("Space meeting lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps Space ownership, runtime authority, finalization, and account deletion independent", async () => {
    const db = await createTestDb();
    const appDb = db;
    const now = new Date("2026-06-29T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    await db.insert(users).values([
      {
        id: "space_owner",
        name: "Space owner",
        email: "owner@example.com",
        normalizedEmail: "owner@example.com",
        plan: "pro",
        role: "user",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "starter",
        name: "Starter",
        email: "starter@example.com",
        normalizedEmail: "starter@example.com",
        plan: "free",
        role: "user",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "member",
        name: "Member",
        email: "member@example.com",
        normalizedEmail: "member@example.com",
        plan: "free",
        role: "user",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(spaces).values({
      kind: "shared",
      id: "space_1",
      slug: "space_1-slug",
      name: "Project",
      ownerUserId: "space_owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values([
      {
        id: "membership_owner",
        spaceId: "space_1",
        userId: "space_owner",
        role: "admin",
        joinedAt: now,
      },
      {
        id: "membership_starter",
        spaceId: "space_1",
        userId: "starter",
        role: "member",
        joinedAt: now,
      },
      {
        id: "membership_member",
        spaceId: "space_1",
        userId: "member",
        role: "member",
        joinedAt: now,
      },
    ]);

    const link = await ensureSpaceDefaultMeetingLink(appDb, "space_1");
    expect(
      await db.query.meetingLinks.findFirst({
        where: { id: link.id },
        columns: { reusePolicy: true, spaceId: true },
      }),
    ).toEqual({ reusePolicy: "reusable", spaceId: "space_1" });

    await expect(
      insertMeetingForLinkWithinLimit(appDb, {
        meetingId: "meeting_1",
        meetingLinkId: link.id,
        title: "Project",
        startedByUserId: "starter",
        billingPrincipal: { type: "user", id: "space_owner" },
        billingPlan: "pro",
        spaceId: "space_1",
        spaceKind: "shared" as const,
        allowGuests: false,
        recordingEnabled: true,
        joinPolicy: "open",
        startedAt: now,
        linkExpiresAt: null,
        maxConcurrentMeetings: 5,
      }),
    ).resolves.toBe(true);

    // What the meeting's room reads of each person's Space authority.
    const meetingRecord = { startedByUserId: "starter", spaceId: "space_1", spaceKind: "shared" as const };
    await expect(spaceRoleFor(appDb, meetingRecord, "space_owner")).resolves.toBe("admin");
    await expect(spaceRoleFor(appDb, meetingRecord, "member")).resolves.toBe("member");

    await expect(
      finalizeMeetingEnd(appDb, { meetingId: "meeting_1", reason: "host", now, summaryOwed: false }),
    ).resolves.toBe(true);
    await db.delete(users).where(eq(users.id, "starter"));

    expect(
      await db.query.meetings.findFirst({
        where: { id: "meeting_1" },
        columns: { status: true, startedByUserId: true },
      }),
    ).toEqual({ status: "ended", startedByUserId: null });
    // The default link is space-owned, so the starter's deletion leaves it
    // untouched.
    expect(
      await db.query.meetingLinks.findFirst({
        where: { id: link.id },
        columns: { spaceId: true },
      }),
    ).toEqual({ spaceId: "space_1" });
  });

  it("snapshots guest entry off for shared-space occurrences regardless of link settings", async () => {
    const db = await createTestDb();
    const appDb = db;
    const now = new Date();
    await db.insert(users).values({
      id: "guest_owner",
      name: "Owner",
      email: "guest-owner@example.com",
      normalizedEmail: "guest-owner@example.com",
      plan: "pro",
      role: "user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaces).values({
      kind: "shared",
      id: "space_guests",
      name: "Guest Policy",
      ownerUserId: "guest_owner",
      slug: "guest-policy",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values({
      id: "membership_guest_owner",
      spaceId: "space_guests",
      userId: "guest_owner",
      role: "admin",
      joinedAt: now,
    });
    const link = await ensureSpaceDefaultMeetingLink(appDb, "space_guests");
    // Guest entry is a personal-space capability, so the DB refuses to let any
    // settings surface flip the flag on a shared-space link at all.
    await expect(
      db
        .update(meetingLinks)
        .set({ allowGuests: true })
        .where(eq(meetingLinks.id, link.id)),
    ).rejects.toThrow();
    const linkRow = await db.query.meetingLinks.findFirst({ where: { id: link.id } });
    expect(linkRow).toMatchObject({ allowGuests: false });

    // Even if a stale in-memory link claimed guests were allowed, the
    // occurrence snapshots the capability off for a shared space.
    const acquired = await acquireMeetingOccurrence(appDb, {
      meetingLink: { ...linkRow!, allowGuests: true, isSpaceDefault: true },
      existingMeeting: null,
      starter: { id: "guest_owner" },
      entitlement: {
        billingPrincipal: { type: "user", id: "guest_owner" },
        plan: "pro",
        limits: {
          recordingEnabled: true,
          maxConcurrentMeetings: 2,
        },
      },
    });
    expect(acquired.createdMeetingId).not.toBeNull();
    expect(acquired.meeting).toMatchObject({ allowGuests: false });
  });
});

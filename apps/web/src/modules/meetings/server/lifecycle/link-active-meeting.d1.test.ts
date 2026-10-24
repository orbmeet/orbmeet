import { seedPersonalSpace } from "@/test/fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { users, meetingLinks, meetings, spaces } from "@orbmeet/db/schema";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

async function insertUser(id: string) {
  const now = new Date();
  await db.insert(users).values({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    image: null,
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertLink(linkId: string, ownerUserId: string) {
  const now = new Date();
  await seedPersonalSpace(db, ownerUserId);
  await db.insert(meetingLinks).values({
    id: linkId,
    code: "abc-defg-hij",
    reusePolicy: "reusable",
    spaceId: `${ownerUserId}_space`,
    spaceKind: "personal" as const,
    title: "Personal link",
    allowGuests: true,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  });
}

function buildMeetingRow(opts: {
  id: string;
  startedByUserId: string;
  meetingLinkId: string;
  status: "open" | "ended";
  spaceId?: string | null;
}) {
  const now = new Date();
  return {
    id: opts.id,
    meetingLinkId: opts.meetingLinkId,
    startedByUserId: opts.startedByUserId,
    spaceId: opts.spaceId ?? `${opts.startedByUserId}_space`,
    spaceKind: opts.spaceId ? ("shared" as const) : ("personal" as const),
    billingPrincipalType: "user" as const,
    billingPrincipalId: opts.startedByUserId,
    billingPlan: "free" as const,
    title: "Weekly sync",
    status: opts.status,
    // Guest entry only exists in personal spaces (schema CHECK).
    allowGuests: !opts.spaceId,
    recordingEnabled: false,
    startedAt: now,
    endedAt: opts.status === "ended" ? now : null,
    activeEgressId: null,
    updatedAt: now,
  } as const;
}

describe("meeting link active Meeting invariant", () => {
  it("enforces at most one active meeting per reusable link", async () => {
    await insertUser("host");
    await insertLink("link_1", "host");

    await db.insert(meetings).values(
      buildMeetingRow({
        id: "meeting_1",
        startedByUserId: "host",
        meetingLinkId: "link_1",
        status: "open",
      }),
    );

    await expect(
      db.insert(meetings).values(
        buildMeetingRow({
          id: "meeting_2",
          startedByUserId: "host",
          meetingLinkId: "link_1",
          status: "open",
        }),
      ),
    ).rejects.toBeDefined();

    const activeRows = await db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(eq(meetings.meetingLinkId, "link_1"), eq(meetings.status, "open")));
    expect(activeRows).toHaveLength(1);
  });

  it("allows historical ended Meetings for the same link", async () => {
    await insertUser("host");
    await insertLink("link_1", "host");

    await db.insert(meetings).values(
      buildMeetingRow({
        id: "meeting_1",
        startedByUserId: "host",
        meetingLinkId: "link_1",
        status: "open",
      }),
    );

    await expect(
      db.insert(meetings).values(
        buildMeetingRow({
          id: "meeting_2",
          startedByUserId: "host",
          meetingLinkId: "link_1",
          status: "ended",
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("allows different personal links to have independent open Meetings", async () => {
    await insertUser("host");
    await insertLink("link_1", "host");
    const now = new Date();
    await db.insert(meetingLinks).values({
      id: "link_2",
      code: "xyz-abcd-uvw",
      reusePolicy: "one_time",
      spaceId: "host_space",
      spaceKind: "personal" as const,
      title: "Scheduled link",
      allowGuests: true,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(meetings).values(buildMeetingRow({
      id: "meeting_1",
      startedByUserId: "host",
      meetingLinkId: "link_1",
      status: "open",
    }));
    await expect(db.insert(meetings).values(buildMeetingRow({
      id: "meeting_2",
      startedByUserId: "host",
      meetingLinkId: "link_2",
      status: "open",
    }))).resolves.toBeDefined();
  });

  it("allows one-time Space links but rejects a second open Meeting", async () => {
    await insertUser("host");
    const now = new Date();
    await db.insert(spaces).values({
      kind: "shared",
      id: "space_1",
      name: "Design",
      slug: "space-1",
      ownerUserId: "host",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetingLinks).values({
      id: "space_link_default",
      code: "one-abcd-one",
      reusePolicy: "reusable",
      spaceId: "space_1", spaceKind: "shared" as const,
      title: "Design",
      allowGuests: false,
      lastUsedAt: now,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await expect(db.insert(meetingLinks).values({
      id: "space_link_scheduled",
      code: "two-abcd-two",
      reusePolicy: "one_time",
      spaceId: "space_1", spaceKind: "shared" as const,
      title: "Scheduled occurrence",
      allowGuests: false,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
    })).resolves.toBeDefined();
    await db.insert(meetings).values(buildMeetingRow({
      id: "space_meeting_1",
      startedByUserId: "host",
      meetingLinkId: "space_link_default",
      status: "open",
      spaceId: "space_1",
    }));

    await expect(db.insert(meetings).values(buildMeetingRow({
      id: "space_meeting_2",
      startedByUserId: "host",
      meetingLinkId: "space_link_default",
      status: "open",
      spaceId: "space_1",
    }))).rejects.toBeDefined();
  });
});

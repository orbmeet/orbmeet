import { describe, expect, it } from "vitest";
import {
  meetingAdmissions,
  meetingConnections,
  meetingLinks,
  meetings,
  spaceMembers,
  spaces,
  users,
} from "@orbmeet/db/schema";
import { boundedStatements } from "@/platform/database/db-batching";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { seedMeetingWhiteboard, seedPersonalSpace } from "@/test/fixtures";
import {
  selectApprovedAdmissionCounts,
  selectParticipantDisplayNames,
} from "./meeting-list-enrichment";
import { selectMyMeetings } from "@/modules/meetings/server/history/personal-meeting-queries.server";

function meetingCode(index: number): string {
  let value = index;
  let letters = "";
  for (let position = 0; position < 10; position += 1) {
    letters = String.fromCharCode(97 + (value % 26)) + letters;
    value = Math.floor(value / 26);
  }
  return `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}`;
}

async function insertUser(db: Awaited<ReturnType<typeof createTestDb>>, id: string) {
  const now = new Date();
  await db.insert(users).values({
    id,
    name: id,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
  await seedPersonalSpace(db, id, { now });
}

async function insertEndedMeeting(
  db: Awaited<ReturnType<typeof createTestDb>>,
  id: string,
  ownerUserId: string,
) {
  const now = new Date();
  const spaceId = await seedPersonalSpace(db, ownerUserId);
  await db.insert(meetingLinks).values({
    id: `link_${id}`,
    code: id === "meeting_1" ? "abc-defg-hij" : "klm-nopq-rst",
    // These fixtures model distinct ad-hoc occurrences. A permanent personal
    // meeting link keeps one link id across all of its Meetings.
    reusePolicy: "one_time",
    spaceId,
    spaceKind: "personal" as const,
    title: id,
    allowGuests: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id,
    meetingLinkId: `link_${id}`,
    spaceId,
    spaceKind: "personal" as const,
    startedByUserId: ownerUserId,
    title: id,
    status: "ended",
    billingPrincipalType: "user" as const,
    billingPrincipalId: ownerUserId,
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    startedAt: now,
    endedAt: now,
    updatedAt: now,
  });
}

describe("meeting queries", () => {
  it("selects participant display names with a per-meeting limit", async () => {
    const db = await createTestDb();
    await insertUser(db, "owner");
    await insertEndedMeeting(db, "meeting_1", "owner");
    await insertEndedMeeting(db, "meeting_2", "owner");
    const now = new Date();
    const admissions = Array.from({ length: 12 }, (_, index) => ({
        id: `admission_1_${index}`,
        meetingId: "meeting_1",
        subjectType: "guest" as const,
        guestSecretHash: "hash",
        displayName: `First ${index}`,
        admissionStatus: "approved" as const,
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      }));
    for (const insert of boundedStatements(admissions, (chunk) => db.insert(meetingAdmissions).values(chunk))) {
      await insert;
    }
    await db.insert(meetingAdmissions).values({
      id: "admission_2",
      meetingId: "meeting_2",
      subjectType: "guest",
      guestSecretHash: "hash",
      displayName: "Second meeting participant",
      admissionStatus: "approved",
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const rows = await selectParticipantDisplayNames(
      db,
      ["meeting_1", "meeting_2"],
    );

    expect(rows.filter((row) => row.meetingId === "meeting_1")).toHaveLength(6);
    expect(rows).toContainEqual({
      meetingId: "meeting_2",
      displayName: "Second meeting participant",
    });
  });

  it("names and counts a person who rejoined once, not once per admission", async () => {
    const db = await createTestDb();
    await insertUser(db, "owner");
    await insertUser(db, "ada");
    await insertEndedMeeting(db, "meeting_1", "owner");
    const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
    const admission = (id: string, userId: string | null, displayName: string, seconds: number) => ({
      id,
      meetingId: "meeting_1",
      subjectType: userId ? ("user" as const) : ("guest" as const),
      subjectUserId: userId,
      guestSecretHash: userId ? null : "hash",
      displayName,
      admissionStatus: "approved" as const,
      decidedAt: at(seconds),
      createdAt: at(seconds),
      updatedAt: at(seconds),
    });
    await db.insert(meetingAdmissions).values([
      admission("adm_ada_1", "ada", "Ada", 1),
      admission("adm_guest", null, "Guest", 2),
      // Ada again: a rejoin after a cleared tab, or a second device.
      admission("adm_ada_2", "ada", "Ada (phone)", 3),
    ]);

    await expect(selectParticipantDisplayNames(db, ["meeting_1"])).resolves.toEqual([
      { meetingId: "meeting_1", displayName: "Ada" },
      { meetingId: "meeting_1", displayName: "Guest" },
    ]);
    await expect(selectApprovedAdmissionCounts(db, ["meeting_1"])).resolves.toEqual([
      { meetingId: "meeting_1", count: 2 },
    ]);
  });

  it("returns one row per meeting when the id list spans multiple D1 chunks", async () => {
    // More than one chunk's worth of meetings (PARTICIPANT_NAME_CHUNK_SIZE = 98)
    // so the IN list is split. Each meeting must still appear exactly once and the
    // per-meeting row_number() ranking must hold across the chunk boundary.
    const db = await createTestDb();
    await insertUser(db, "owner");
    const now = new Date();
    const meetingCount = 205;
    for (let i = 0; i < meetingCount; i += 1) {
      await db.insert(meetingLinks).values({
        id: `link_chunk_${i}`,
        code: `aaa-bbbb-${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}z`,
        spaceId: "owner_space",
        spaceKind: "personal" as const,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(meetings).values({
        id: `chunk_meeting_${i}`,
        meetingLinkId: `link_chunk_${i}`,
    spaceId: "owner_space",
    spaceKind: "personal" as const,
        startedByUserId: "owner",
        status: "ended",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "owner",
    billingPlan: "free",
        startedAt: now,
        endedAt: now,
        updatedAt: now,
      });
      await db.insert(meetingAdmissions).values({
        id: `chunk_admission_${i}`,
        meetingId: `chunk_meeting_${i}`,
        subjectType: "guest",
        guestSecretHash: "hash",
        displayName: `Participant ${i}`,
        admissionStatus: "approved",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    const meetingIds = Array.from({ length: meetingCount }, (_, i) => `chunk_meeting_${i}`);
    const rows = await selectParticipantDisplayNames(db, meetingIds);

    expect(rows).toHaveLength(meetingCount);
    expect(new Set(rows.map((row) => row.meetingId)).size).toBe(meetingCount);
  });

  it("treats LIKE wildcard characters as literal search text", async () => {
    const db = await createTestDb();
    await insertUser(db, "owner");
    await insertEndedMeeting(db, "meeting_1", "owner");
    const now = new Date();
    await db.insert(meetingAdmissions).values({
      id: "admission_owner",
      meetingId: "meeting_1",
      subjectType: "user",
      subjectUserId: "owner",
      displayName: "100% Real",
      admissionStatus: "approved",
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetingConnections).values({
      id: "connection_owner",
      meetingId: "meeting_1",
      admissionId: "admission_owner",
      livekitIdentity: "owner_identity",
      userId: "owner",
      role: "host",
      connectionStatus: "ended",
      reason: "voluntary",
      tokenIssuedAt: now,
      connectedAt: now,
      disconnectedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      selectMyMeetings(db, { id: "owner" }, { status: "all", scope: "all", limit: 20, search: "%" }),
    ).resolves.toMatchObject({
      meetings: [{ id: "meeting_1" }],
    });
    // As LIKE patterns both would match "100% Real"; as literal text neither
    // appears in the title, code, starter, or any participant name.
    for (const search of ["1_0", "1%l"]) {
      await expect(
        selectMyMeetings(db, { id: "owner" }, { status: "all", scope: "all", limit: 20, search }),
      ).resolves.toMatchObject({ meetings: [] });
    }
  });

  it("keeps participant search within D1's parameter budget at 91 matches", async () => {
    const db = await createTestDb();
    await insertUser(db, "owner");
    const now = new Date();
    for (let index = 0; index < 91; index += 1) {
      await db.insert(meetingLinks).values({
        id: `search_link_${index}`,
        code: meetingCode(index),
        reusePolicy: "one_time",
        spaceId: "owner_space",
        spaceKind: "personal",
        allowGuests: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(meetings).values({
        id: `search_meeting_${index}`,
        meetingLinkId: `search_link_${index}`,
        spaceId: "owner_space",
        spaceKind: "personal",
        startedByUserId: "owner",
        title: `Search meeting ${index}`,
        status: "ended",
        billingPrincipalType: "user",
        billingPrincipalId: "owner",
        billingPlan: "free",
        allowGuests: true,
        recordingEnabled: false,
        startedAt: new Date(now.getTime() + index),
        endedAt: new Date(now.getTime() + index),
        updatedAt: new Date(now.getTime() + index),
      });
      await db.insert(meetingAdmissions).values({
        id: `search_admission_${index}`,
        meetingId: `search_meeting_${index}`,
        subjectType: "guest",
        guestSecretHash: "hash",
        displayName: "Boundary Match",
        admissionStatus: "approved",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    const result = await selectMyMeetings(db, { id: "owner" }, { status: "all", scope: "all", limit: 20, search: "Boundary Match" });

    expect(result.meetings).toHaveLength(20);
  });

  it("scopes participant search before limiting matches", async () => {
    const db = await createTestDb();
    await insertUser(db, "owner");
    await insertUser(db, "other");
    const now = new Date();

    const insertSearchMeeting = async (
      id: string,
      ownerUserId: "owner" | "other",
      index: number,
    ) => {
      const spaceId = `${ownerUserId}_space`;
      await db.insert(meetingLinks).values({
        id: `link_${id}`,
        code: meetingCode(index),
        reusePolicy: "one_time",
        spaceId,
        spaceKind: "personal",
        allowGuests: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(meetings).values({
        id,
        meetingLinkId: `link_${id}`,
        spaceId,
        spaceKind: "personal",
        startedByUserId: ownerUserId,
        status: "ended",
        billingPrincipalType: "user",
        billingPrincipalId: ownerUserId,
        billingPlan: "free",
        allowGuests: true,
        recordingEnabled: false,
        startedAt: now,
        endedAt: now,
        updatedAt: now,
      });
      await db.insert(meetingAdmissions).values({
        id: `admission_${id}`,
        meetingId: id,
        subjectType: "guest",
        guestSecretHash: "hash",
        displayName: "Common Match",
        admissionStatus: "approved",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    };

    for (let index = 0; index < 90; index += 1) {
      await insertSearchMeeting(
        `a_unrelated_${index.toString().padStart(2, "0")}`,
        "other",
        index,
      );
    }
    await insertSearchMeeting("z_accessible", "owner", 90);

    const result = await selectMyMeetings(db, { id: "owner" }, { status: "all", scope: "all", limit: 20, search: "Common Match" });

    expect(result.meetings.map(({ id }) => id)).toEqual(["z_accessible"]);
  });

  it("projects the current participant count for active Meetings", async () => {
    const db = await createTestDb();
    await insertUser(db, "owner");
    await insertEndedMeeting(db, "meeting_1", "owner");
    const now = new Date();

    await db
      .update(meetings)
      .set({ status: "open", endedAt: null, updatedAt: now })
      .where(eq(meetings.id, "meeting_1"));
    await db.insert(meetingAdmissions).values({
      id: "admission_live_owner",
      meetingId: "meeting_1",
      subjectType: "user",
      subjectUserId: "owner",
      displayName: "Owner",
      admissionStatus: "approved",
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetingConnections).values({
      id: "connection_live_owner",
      meetingId: "meeting_1",
      admissionId: "admission_live_owner",
      livekitIdentity: "owner_live_identity",
      userId: "owner",
      role: "host",
      connectionStatus: "live",
      tokenIssuedAt: now,
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      selectMyMeetings(db, { id: "owner" }, {
        status: "open",
        scope: "all",
        limit: 30,
      }),
    ).resolves.toMatchObject({
      meetings: [{
        id: "meeting_1",
        status: "open",
        participantCount: 1,
        liveParticipantCount: 1,
      }],
    });
  });

  it("pages on a cursor that names no Meeting, and refuses one it did not issue", async () => {
    const db = await createTestDb();
    await insertUser(db, "owner");
    await insertEndedMeeting(db, "meeting_1", "owner");
    await insertEndedMeeting(db, "meeting_2", "owner");
    await db.update(meetings).set({ startedAt: new Date(0), endedAt: new Date(0), updatedAt: new Date(0) }).where(eq(meetings.id, "meeting_1"));
    const page = (cursor?: string) =>
      selectMyMeetings(db, { id: "owner" }, { status: "ended", scope: "all", limit: 1, cursor });

    const first = await page();
    expect(first.meetings.map((meeting) => meeting.id)).toEqual(["meeting_2"]);
    // The page's last Meeting leaves the caller's history; the next page does
    // not need it, and so cannot tell anyone whether it still exists.
    await db.delete(meetings).where(eq(meetings.id, "meeting_2"));
    const second = await page(first.nextCursor);
    expect(second.meetings.map((meeting) => meeting.id)).toEqual(["meeting_1"]);

    // A bare id is not a cursor: refused, foreign or missing alike.
    await expect(page("meeting_1")).rejects.toThrow("Invalid meeting cursor");
  });

  it("drops shared Meeting history when Space membership ends, admission or not", async () => {
    const db = await createTestDb();
    await insertUser(db, "owner");
    await insertUser(db, "member");
    const now = new Date();
    await db.insert(spaces).values({
      kind: "shared",
      id: "space_1",
      slug: "space_1-slug",
      name: "Product",
      ownerUserId: "owner",
      organizationId: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values([
      { id: "membership_owner", spaceId: "space_1", userId: "owner", role: "admin", joinedAt: now },
      { id: "membership_member", spaceId: "space_1", userId: "member", role: "member", joinedAt: now },
    ]);
    await db.insert(meetingLinks).values({
      id: "link_space_1",
      code: "spc-hist-ory",
      spaceId: "space_1",
spaceKind: "shared" as const,
      reusePolicy: "reusable",
      allowGuests: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetings).values({
      id: "meeting_space_1",
      meetingLinkId: "link_space_1",
      startedByUserId: "owner",
      spaceId: "space_1",
    spaceKind: "shared" as const,
      status: "ended",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "owner",
    billingPlan: "free",
      startedAt: now,
      endedAt: now,
      updatedAt: now,
    });

    await expect(
      selectMyMeetings(db, { id: "member" }, { status: "all", scope: "all", limit: 30 }),
    ).resolves.toMatchObject({ meetings: [{ id: "meeting_space_1" }] });

    await db.delete(spaceMembers).where(eq(spaceMembers.id, "membership_member"));
    await expect(
      selectMyMeetings(db, { id: "member" }, { status: "all", scope: "all", limit: 30 }),
    ).resolves.toMatchObject({ meetings: [] });

    // Nor does the admission they really attended on. Shared-Space entry is
    // member-guarded, so this row could only ever belong to a member — and
    // eviction leaves it `approved` because it only revokes admissions on
    // Meetings that are still open. Honouring it here would hand every removed
    // member a permanent second key to the Space's recordings and transcripts.
    // (The personal-Space case, where the admission *is* the only record of
    // attendance, is the test immediately below.)
    await db.insert(meetingAdmissions).values({
      id: "admission_member",
      meetingId: "meeting_space_1",
      subjectType: "user",
      subjectUserId: "member",
      displayName: "member",
      admissionStatus: "approved",
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      selectMyMeetings(db, { id: "member" }, { status: "all", scope: "all", limit: 30 }),
    ).resolves.toMatchObject({ meetings: [] });
    await expect(
      selectMyMeetings(db, { id: "member" }, {
        status: "all",
        scope: "all",
        limit: 30,
      }),
    ).resolves.toMatchObject({ meetings: [] });
  });

  it("keeps personal-space meetings visible to their admitted attendees", async () => {
    const db = await createTestDb();
    await insertUser(db, "owner");
    await insertUser(db, "attendee");
    await insertEndedMeeting(db, "meeting_1", "owner");
    const now = new Date();
    await db.insert(meetingAdmissions).values({
      id: "admission_attendee",
      meetingId: "meeting_1",
      subjectType: "user",
      subjectUserId: "attendee",
      displayName: "Attendee",
      admissionStatus: "approved",
      decidedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetingConnections).values({
      id: "connection_attendee",
      meetingId: "meeting_1",
      admissionId: "admission_attendee",
      livekitIdentity: "attendee_connection",
      userId: "attendee",
      role: "attendee",
      connectionStatus: "ended",
      tokenIssuedAt: now,
      connectedAt: now,
      disconnectedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Matches canAccessMeetingHistory: someone who attended a personal-space
    // Meeting retains access to its history. The personal space itself is
    // projected out of the payload.
    await expect(
      selectMyMeetings(db, { id: "attendee" }, { status: "all", scope: "all", limit: 30 }),
    ).resolves.toMatchObject({
      meetings: [{ id: "meeting_1", spaceId: null, spaceName: null }],
    });
    await expect(
      selectMyMeetings(db, { id: "attendee" }, {
        status: "all",
        scope: "all",
        limit: 30,
      }),
    ).resolves.toMatchObject({
      meetings: [{ id: "meeting_1", spaceId: null, spaceName: null }],
    });
  });

  it("scopes the meeting library by the space kind snapshot", async () => {
    const db = await createTestDb();
    await insertUser(db, "owner");
    await insertEndedMeeting(db, "meeting_personal", "owner");
    const now = new Date();
    await db.insert(spaces).values({
      kind: "shared",
      id: "space_1",
      slug: "space_1-slug",
      name: "Product",
      ownerUserId: "owner",
      organizationId: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(spaceMembers).values({
      id: "membership_owner_shared",
      spaceId: "space_1",
      userId: "owner",
      role: "admin",
      joinedAt: now,
    });
    await db.insert(meetingLinks).values({
      id: "link_shared",
      code: "spc-scop-efg",
      spaceId: "space_1",
spaceKind: "shared" as const,
      reusePolicy: "reusable",
      allowGuests: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetings).values({
      id: "meeting_shared",
      meetingLinkId: "link_shared",
      spaceId: "space_1",
      spaceKind: "shared" as const,
      startedByUserId: "owner",
      status: "ended",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "owner",
      billingPlan: "free",
      startedAt: now,
      endedAt: now,
      updatedAt: now,
    });

    const personal = await selectMyMeetings(db, { id: "owner" }, {
      status: "all",
      scope: "personal",
      limit: 30,
    });
    expect(personal.meetings.map((m) => m.id)).toEqual(["meeting_personal"]);

    const shared = await selectMyMeetings(db, { id: "owner" }, {
      status: "all",
      scope: "spaces",
      limit: 30,
    });
    expect(shared.meetings.map((m) => m.id)).toEqual(["meeting_shared"]);
    expect(shared.meetings[0]).toMatchObject({ spaceId: "space_1", spaceName: "Product" });
  });

  it("lists only meetings that started inside a window, however many came after it", async () => {
    const db = await createTestDb();
    await insertUser(db, "owner");
    await insertEndedMeeting(db, "meeting_1", "owner");
    await insertEndedMeeting(db, "meeting_2", "owner");
    const inWeek = new Date("2026-09-15T10:00:00Z");
    const later = new Date("2026-10-01T10:00:00Z");
    await db.update(meetings).set({ startedAt: inWeek, endedAt: inWeek }).where(eq(meetings.id, "meeting_1"));
    await db.update(meetings).set({ startedAt: later, endedAt: later }).where(eq(meetings.id, "meeting_2"));

    const week = await selectMyMeetings(db, { id: "owner" }, {
      status: "ended",
      scope: "all",
      since: Date.parse("2026-09-14T00:00:00Z"),
      until: Date.parse("2026-09-21T00:00:00Z"),
      // One row a page: without an end, the later meeting would take it.
      limit: 1,
    });

    expect(week.meetings.map((meeting) => meeting.id)).toEqual(["meeting_1"]);
  });

  it("filters by Whiteboard use even when no PDF was generated", async () => {
    const db = await createTestDb();
    await insertUser(db, "owner");
    await insertEndedMeeting(db, "meeting_1", "owner");
    await insertEndedMeeting(db, "meeting_2", "owner");
    await seedMeetingWhiteboard(db, {
      meetingId: "meeting_1",
      spaceId: "owner_space",
      whiteboardId: "whiteboard_filter",
    });

    const result = await selectMyMeetings(db, { id: "owner" }, {
      status: "all",
      scope: "all",
      hasWhiteboard: true,
      limit: 30,
    });

    expect(result.meetings.map((meeting) => meeting.id)).toEqual(["meeting_1"]);
    expect(result.meetings[0]).toMatchObject({ hasWhiteboardPdf: false });
  });
});

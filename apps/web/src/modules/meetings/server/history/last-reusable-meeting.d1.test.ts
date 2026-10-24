import { beforeEach, describe, expect, it } from "vitest";
import {
  meetingAdmissions,
  meetingConnections,
  meetingLinks,
  meetings,
  users,
} from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedSharedSpace } from "@/test/fixtures";
import {selectMyLastReusableMeeting} from "@/modules/meetings/server/history/last-reusable-meeting.server";

let db: TestDb;
const getAppDb = () => db;

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

type LinkKind = "reusable" | "one_time";

async function insertSpaceLink(opts: {
  linkId: string;
  code: string;
  spaceId: string;
  reusePolicy: LinkKind;
  title?: string | null;
}) {
  const now = new Date();
  await db.insert(meetingLinks).values({
    id: opts.linkId,
    code: opts.code,
    reusePolicy: opts.reusePolicy,
    spaceId: opts.spaceId,
    spaceKind: "shared" as const,
    title: opts.title ?? null,
    allowGuests: false,
    joinPolicy: "open",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertEndedMeeting(opts: {
  meetingId: string;
  linkId: string;
  spaceId: string;
  startedByUserId: string;
  startedAt: Date;
}) {
  await db.insert(meetings).values({
    id: opts.meetingId,
    meetingLinkId: opts.linkId,
    spaceId: opts.spaceId,
    spaceKind: "shared" as const,
    startedByUserId: opts.startedByUserId,
    status: "ended",
    billingPrincipalType: "user" as const,
    billingPrincipalId: opts.startedByUserId,
    billingPlan: "free",
    allowGuests: false,
    recordingEnabled: false,
    startedAt: opts.startedAt,
    endedAt: opts.startedAt,
    updatedAt: opts.startedAt,
  });
}

async function insertAdmission(opts: {
  admissionId: string;
  meetingId: string;
  userId: string;
  createdAt: Date;
}) {
  await db.insert(meetingAdmissions).values({
    id: opts.admissionId,
    meetingId: opts.meetingId,
    subjectType: "user",
    subjectUserId: opts.userId,
    guestSecretHash: null,
    displayName: opts.userId,
    admissionStatus: "approved",
    decidedAt: opts.createdAt,
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  });
}

describe("selectMyLastReusableMeeting", () => {
  it("returns the most recently joined reusable Space room with live status", async () => {
    await insertUser("alice");
    await seedSharedSpace(db, { id: "team", ownerUserId: "alice", name: "Acme Team", slug: "acme", members: [{ userId: "alice" }] });

    const earlier = new Date(2_000);
    const later = new Date(5_000);

    // An older recurring Meeting Alice joined first.
    await seedSharedSpace(db, { id: "old_team", ownerUserId: "alice", members: [{ userId: "alice" }] });
    await insertSpaceLink({ linkId: "link_old", code: "aaa-aaaa-aaa", spaceId: "old_team", reusePolicy: "reusable" });
    await insertEndedMeeting({ meetingId: "m_old", linkId: "link_old", spaceId: "old_team", startedByUserId: "alice", startedAt: earlier });
    await insertAdmission({ admissionId: "adm_old", meetingId: "m_old", userId: "alice", createdAt: earlier });

    // The recurring Meeting Alice joined most recently — this one should win.
    await insertSpaceLink({ linkId: "link_team", code: "bbb-bbbb-bbb", spaceId: "team", reusePolicy: "reusable", title: "Standup" });
    await insertEndedMeeting({ meetingId: "m_team", linkId: "link_team", spaceId: "team", startedByUserId: "alice", startedAt: later });
    await insertAdmission({ admissionId: "adm_team", meetingId: "m_team", userId: "alice", createdAt: later });

    const result = await selectMyLastReusableMeeting(getAppDb(), { id: "alice" }, new Date(10_000));

    expect(result).toMatchObject({
      code: "bbb-bbbb-bbb",
      linkTitle: "Standup",
      spaceKind: "shared",
      spaceName: "Acme Team",
      spaceSlug: "acme",
      hasOpenMeeting: false,
      liveParticipantCount: 0,
    });
    expect(result?.lastJoinedAt).toBe(new Date(5_000).toISOString());
  });

  it("excludes one-time meetings", async () => {
    await insertUser("alice");
    await seedSharedSpace(db, { id: "team", ownerUserId: "alice", members: [{ userId: "alice" }] });

    await insertSpaceLink({ linkId: "link_once", code: "ccc-cccc-ccc", spaceId: "team", reusePolicy: "one_time" });
    await insertEndedMeeting({ meetingId: "m_once", linkId: "link_once", spaceId: "team", startedByUserId: "alice", startedAt: new Date(5_000) });
    await insertAdmission({ admissionId: "adm_once", meetingId: "m_once", userId: "alice", createdAt: new Date(5_000) });

    const result = await selectMyLastReusableMeeting(getAppDb(), { id: "alice" }, new Date(10_000));
    expect(result).toBeNull();
  });

  it("does not surface a Space room the user can no longer access", async () => {
    await insertUser("alice");
    await insertUser("owner");
    // alice is NOT a member of this space anymore (members list omits her).
    await seedSharedSpace(db, { id: "team", ownerUserId: "owner", members: [{ userId: "owner" }] });

    await insertSpaceLink({ linkId: "link_team", code: "ddd-dddd-ddd", spaceId: "team", reusePolicy: "reusable" });
    await insertEndedMeeting({ meetingId: "m_team", linkId: "link_team", spaceId: "team", startedByUserId: "owner", startedAt: new Date(5_000) });
    await insertAdmission({ admissionId: "adm_team", meetingId: "m_team", userId: "alice", createdAt: new Date(5_000) });

    const result = await selectMyLastReusableMeeting(getAppDb(), { id: "alice" }, new Date(10_000));
    expect(result).toBeNull();
  });

  it("counts live participants in the room's current open meeting", async () => {
    await insertUser("alice");
    await insertUser("bob");
    await seedSharedSpace(db, { id: "team", ownerUserId: "alice", members: [{ userId: "alice" }, { userId: "bob" }] });

    await insertSpaceLink({ linkId: "link_team", code: "eee-eeee-eee", spaceId: "team", reusePolicy: "reusable" });

    // A past ended occurrence is what alice joined.
    await insertEndedMeeting({ meetingId: "m_team", linkId: "link_team", spaceId: "team", startedByUserId: "alice", startedAt: new Date(1_000) });
    await insertAdmission({ admissionId: "adm_team", meetingId: "m_team", userId: "alice", createdAt: new Date(1_000) });

    // The reusable link's current open occurrence, with two live connections.
    const now = new Date(9_000);
    await db.insert(meetings).values({
      id: "m_open",
      meetingLinkId: "link_team",
      spaceId: "team",
      spaceKind: "shared" as const,
      startedByUserId: "alice",
      status: "open",
      billingPrincipalType: "user" as const,
      billingPrincipalId: "alice",
      billingPlan: "free",
      allowGuests: false,
      recordingEnabled: false,
      startedAt: now,
      updatedAt: now,
    });
    await insertAdmission({ admissionId: "adm_open_alice", meetingId: "m_open", userId: "alice", createdAt: now });
    await insertAdmission({ admissionId: "adm_open_bob", meetingId: "m_open", userId: "bob", createdAt: now });
    await db.insert(meetingConnections).values([
      {
        id: "conn_alice",
        meetingId: "m_open",
        admissionId: "adm_open_alice",
        livekitIdentity: "alice_conn",
        livekitParticipantSid: "PA_alice",
        userId: "alice",
        role: "host",
        connectionStatus: "live",
        reason: null,
        tokenIssuedAt: now,
        connectedAt: now,
        disconnectedAt: null,
        lastWebhookAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "conn_bob",
        meetingId: "m_open",
        admissionId: "adm_open_bob",
        livekitIdentity: "bob_conn",
        livekitParticipantSid: "PA_bob",
        userId: "bob",
        role: "attendee",
        connectionStatus: "live",
        reason: null,
        tokenIssuedAt: now,
        connectedAt: now,
        disconnectedAt: null,
        lastWebhookAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await selectMyLastReusableMeeting(getAppDb(), { id: "alice" }, new Date(10_000));
    expect(result).toMatchObject({
      code: "eee-eeee-eee",
      hasOpenMeeting: true,
      liveParticipantCount: 2,
    });
  });

  it("returns null when the user has never joined a recurring Meeting", async () => {
    await insertUser("alice");
    const result = await selectMyLastReusableMeeting(getAppDb(), { id: "alice" }, new Date(10_000));
    expect(result).toBeNull();
  });
});

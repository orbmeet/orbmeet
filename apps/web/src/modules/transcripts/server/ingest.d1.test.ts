import { seedPersonalSpace } from "@/test/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  meetingAdmissions,
  meetingConnections,
  meetingLinks,
  meetingSummaries,
  meetings,
  transcripts,
  users,
} from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import {
  buildDeepgramTranscriptRows,
  clampSegmentStartedAt,
  findTranscriptionParticipant,
  ingestDeepgramTranscripts,
} from "./ingest";
import { DISCONNECTED_TRANSCRIPT_GRACE_MS } from "@/modules/meetings/contract/constants";

const jobs = vi.hoisted(() => ({ started: [] as unknown[], unavailable: false }));
vi.mock("@/platform/jobs/jobs", async (original) => ({
  ...(await original<object>()),
  startJob: async (_env: unknown, job: unknown) => {
    if (jobs.unavailable) throw new Error("Workflows unavailable");
    jobs.started.push(job);
  },
}));

/** Summaries are configured, so late text owes one. */
const summaryEnv = { AI_API_KEY: "key", AI_MODEL: "model" } as unknown as Env;

let db: TestDb;
const getAppDb = () => db;
const now = new Date("2026-06-30T00:00:00.000Z");

beforeEach(async () => {
  jobs.started.length = 0;
  jobs.unavailable = false;
  vi.useFakeTimers();
  vi.setSystemTime(now);
  db = await createTestDb();

  await db.insert(users).values({
    id: "host",
    name: "Host",
    email: "host@example.com",
    normalizedEmail: "host@example.com",
    image: null,
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
  await seedPersonalSpace(db, "host");
  await db.insert(meetingLinks).values({
    id: "room_1",
    code: "abc-defg-hij",
    spaceId: "host_space",
spaceKind: "personal" as const,
    title: "Meeting",
    allowGuests: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: "meeting_1",
    meetingLinkId: "room_1",
    spaceId: "host_space",
    spaceKind: "personal" as const,
    startedByUserId: "host",
    title: "Meeting",
    status: "open",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "host",
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    startedAt: now,
    updatedAt: now,
  });
  await db.insert(meetingAdmissions).values({
    id: "admission_1",
    meetingId: "meeting_1",
    subjectType: "user",
    subjectUserId: "host",
    displayName: "Host",
    admissionStatus: "approved",
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function insertDisconnectedConnection(
  id: string,
  identity: string,
  disconnectedAt: Date,
) {
  await db.insert(meetingConnections).values({
    id,
    meetingId: "meeting_1",
    admissionId: "admission_1",
    livekitIdentity: identity,
    userId: "host",
    role: "host",
    connectionStatus: "ended",
    tokenIssuedAt: new Date(disconnectedAt.getTime() - 60_000),
    connectedAt: new Date(disconnectedAt.getTime() - 30_000),
    disconnectedAt,
    createdAt: new Date(disconnectedAt.getTime() - 60_000),
    updatedAt: disconnectedAt,
  });
}

describe("transcript ingestion identity resolution", () => {
  it("accepts any previously-live connection so a durable backlog can drain", async () => {
    await insertDisconnectedConnection(
      "connection_recent",
      "recent_identity",
      new Date(now.getTime() - 60_000),
    );
    await insertDisconnectedConnection(
      "connection_stale",
      "stale_identity",
      new Date(now.getTime() - 3 * 60_000),
    );

    await expect(
      findTranscriptionParticipant(getAppDb(), "meeting_1", "recent_identity"),
    ).resolves.toMatchObject({ connectionId: "connection_recent" });
    await expect(
      findTranscriptionParticipant(getAppDb(), "meeting_1", "stale_identity"),
    ).resolves.toMatchObject({ connectionId: "connection_stale" });
  });

  it("still attributes speech captured before its speaker was removed", async () => {
    await insertDisconnectedConnection("connection_removed", "removed_identity", new Date(now.getTime() - 5_000));
    await db.update(meetingAdmissions)
      .set({ admissionStatus: "revoked", decisionReason: "removed_by_moderator", decidedAt: now, updatedAt: now })
      .where(eq(meetingAdmissions.id, "admission_1"));

    await expect(ingestDeepgramTranscripts(getAppDb(), summaryEnv, {
      meetingId: "meeting_1",
      participantIdentity: "removed_identity",
      segments: [{ text: "said before removal", startedAt: now.getTime() - 10_000, segmentId: "seg-removed" }],
    })).resolves.toEqual({ submitted: 1 });
    await expect(db.query.transcripts.findFirst({ where: { segmentId: "deepgram:seg-removed" } }))
      .resolves.toMatchObject({ admissionId: "admission_1", text: "said before removal" });
  });

  it("names nobody for a connection whose admission was never let in", async () => {
    await db.insert(meetingAdmissions).values({
      id: "admission_denied", meetingId: "meeting_1", subjectType: "user", subjectUserId: "host",
      displayName: "Host", admissionStatus: "denied", decidedAt: now, createdAt: now, updatedAt: now,
    });
    await db.insert(meetingConnections).values({
      id: "connection_denied", meetingId: "meeting_1", admissionId: "admission_denied",
      livekitIdentity: "denied_identity", userId: "host", role: "attendee", connectionStatus: "ended",
      tokenIssuedAt: now, connectedAt: now, disconnectedAt: now, createdAt: now, updatedAt: now,
    });
    await expect(findTranscriptionParticipant(getAppDb(), "meeting_1", "denied_identity")).resolves.toBeNull();
  });

  it("bumps the meeting's transcript counters by inserted segments only", async () => {
    await insertDisconnectedConnection(
      "connection_recent",
      "recent_identity",
      new Date(now.getTime() - 60_000),
    );
    const input = {
      meetingId: "meeting_1",
      participantIdentity: "recent_identity",
      segments: [
        { text: "One", startedAt: now.getTime() - 10_000, segmentId: "seg-1" },
        { text: "Two", startedAt: now.getTime() - 5_000, segmentId: "seg-2" },
      ],
    };

    await ingestDeepgramTranscripts(getAppDb(), summaryEnv, input);
    // Re-ingesting the same segments is conflict-skipped and must not
    // double-count.
    await ingestDeepgramTranscripts(getAppDb(), summaryEnv, input);

    const [meeting] = await db
      .select({
        transcriptSegmentCount: meetings.transcriptSegmentCount,
        transcriptLastIngestedAt: meetings.transcriptLastIngestedAt,
      })
      .from(meetings)
      .where(eq(meetings.id, "meeting_1"));
    expect(meeting?.transcriptSegmentCount).toBe(2);
    expect(meeting?.transcriptLastIngestedAt).toEqual(now);
  });

  it("updates the projection atomically for inserts outside the ingest helper", async () => {
    await insertDisconnectedConnection(
      "connection_recent",
      "recent_identity",
      new Date(now.getTime() - 60_000),
    );
    await db.insert(transcripts).values({
      id: "transcript_existing",
      meetingId: "meeting_1",
      admissionId: "admission_1",
      connectionId: "connection_recent",
      participantIdentity: "recent_identity",
      participantName: "Host",
      text: "Already committed",
      segmentId: "deepgram:repair-1",
      language: null,
      startedAt: new Date(now.getTime() - 5_000),
      updatedAt: now,
    });

    await expect(db.query.meetings.findFirst({ where: { id: "meeting_1" } }))
      .resolves.toMatchObject({
        transcriptSegmentCount: 1,
        transcriptLastIngestedAt: now,
      });
  });

  it("owes a new Summary when the final Transcript arrives after it was settled", async () => {
    await insertDisconnectedConnection(
      "connection_recent",
      "recent_identity",
      new Date(now.getTime() - 60_000),
    );
    await db
      .update(meetings)
      .set({ status: "ended", endedAt: now, summaryStatus: "settled" })
      .where(eq(meetings.id, "meeting_1"));

    const delivery = {
      meetingId: "meeting_1",
      participantIdentity: "recent_identity",
      segments: [{ text: "Final words", startedAt: now.getTime(), segmentId: "late-1" }],
    };
    await ingestDeepgramTranscripts(getAppDb(), summaryEnv, delivery);

    await expect(db.query.meetings.findFirst({ where: { id: "meeting_1" } }))
      .resolves.toMatchObject({ summaryStatus: "pending", transcriptSegmentCount: 1 });
    expect(jobs.started).toEqual([
      expect.objectContaining({ kind: "summarizeMeeting", meetingId: "meeting_1" }),
    ]);

    // The first delivery committed its text but failed before owing the
    // Summary; its replay inserts nothing and still repairs that.
    jobs.started.length = 0;
    await db.update(meetings).set({ summaryStatus: "settled" }).where(eq(meetings.id, "meeting_1"));
    await ingestDeepgramTranscripts(getAppDb(), summaryEnv, delivery);
    expect(jobs.started).toEqual([
      expect.objectContaining({ kind: "summarizeMeeting", meetingId: "meeting_1" }),
    ]);
  });

  it("starts the Summary's job on a replay when the first delivery could not", async () => {
    await insertDisconnectedConnection(
      "connection_recent",
      "recent_identity",
      new Date(now.getTime() - 60_000),
    );
    await db
      .update(meetings)
      .set({ status: "ended", endedAt: now, summaryStatus: "settled" })
      .where(eq(meetings.id, "meeting_1"));
    const delivery = {
      meetingId: "meeting_1",
      participantIdentity: "recent_identity",
      segments: [{ text: "Final words", startedAt: now.getTime(), segmentId: "late-1" }],
    };

    // The rows commit and the Summary is owed, but its job never starts.
    jobs.unavailable = true;
    await expect(ingestDeepgramTranscripts(getAppDb(), summaryEnv, delivery)).rejects.toThrow("Workflows unavailable");
    await expect(db.query.meetings.findFirst({ where: { id: "meeting_1" } }))
      .resolves.toMatchObject({ summaryStatus: "pending", transcriptSegmentCount: 1 });

    // The agent's replay inserts nothing, and still starts it.
    jobs.unavailable = false;
    await ingestDeepgramTranscripts(getAppDb(), summaryEnv, delivery);
    expect(jobs.started).toEqual([
      expect.objectContaining({ kind: "summarizeMeeting", meetingId: "meeting_1" }),
    ]);
  });

  it("does not regenerate a Summary that already covers a replayed delivery", async () => {
    // A captured request replayed after the summary is complete inserts no
    // rows and has nothing to add. Owing a new one anyway paid for a fresh
    // model run on every replay.
    await insertDisconnectedConnection(
      "connection_recent",
      "recent_identity",
      new Date(now.getTime() - 60_000),
    );
    await db
      .update(meetings)
      .set({ status: "ended", endedAt: now, summaryStatus: "pending" })
      .where(eq(meetings.id, "meeting_1"));

    const delivery = {
      meetingId: "meeting_1",
      participantIdentity: "recent_identity",
      segments: [{ text: "Final words", startedAt: now.getTime(), segmentId: "late-1" }],
    };
    await ingestDeepgramTranscripts(getAppDb(), summaryEnv, delivery);

    // The summary now covers everything committed, and is settled.
    const meeting = await db.query.meetings.findFirst({
      where: { id: "meeting_1" },
      columns: { transcriptSegmentCount: true },
    });
    await db.insert(meetingSummaries).values({
      id: "summary_1",
      meetingId: "meeting_1",
      summary: "Summary",
      transcriptSegmentCount: meeting!.transcriptSegmentCount,
      transcriptLastUpdatedAt: now,
      createdAt: now,
    });
    await db.update(meetings).set({ summaryStatus: "settled" }).where(eq(meetings.id, "meeting_1"));
    jobs.started.length = 0;

    await ingestDeepgramTranscripts(getAppDb(), summaryEnv, delivery);

    expect(jobs.started).toEqual([]);
    await expect(db.query.meetings.findFirst({ where: { id: "meeting_1" } }))
      .resolves.toMatchObject({ summaryStatus: "settled" });
  });

  it("clamps a future agent timestamp to the Worker clock", () => {
    const [row] = buildDeepgramTranscriptRows(
      {
        meetingId: "meeting_1",
        participantIdentity: "recent_identity",
        segments: [{
          text: "Clock skew",
          startedAt: now.getTime() + 30_000,
          language: "en-US",
          segmentId: "request:0.000",
        }],
      },
      {
        admissionId: "admission_1",
        connectionId: "connection_recent",
        displayName: "Host",
        livekitIdentity: "recent_identity",
      },
      { startedAt: new Date(now.getTime() - 60_000), endedAt: null },
    );

    expect(row.startedAt).toEqual(now);
    expect(row.updatedAt).toEqual(now);
  });
});

describe("clampSegmentStartedAt", () => {
  const meetingStartedAt = new Date("2026-07-01T10:00:00.000Z");
  const meetingEndedAt = new Date("2026-07-01T11:00:00.000Z");
  const wallClock = new Date("2026-07-01T12:00:00.000Z");

  it("keeps a time inside the meeting untouched", () => {
    const inside = new Date("2026-07-01T10:30:00.000Z");
    expect(
      clampSegmentStartedAt(inside.getTime(), {
        startedAt: meetingStartedAt,
        endedAt: meetingEndedAt,
      }, wallClock),
    ).toEqual(inside);
  });

  it("refuses to file a segment before the meeting began", () => {
    // `startedAt` is caller-supplied and was only clamped forward, so any past
    // time was accepted verbatim — enough to reorder scrollback and the summary
    // around a fabricated timestamp.
    expect(
      clampSegmentStartedAt(new Date("2020-01-01T00:00:00.000Z").getTime(), {
        startedAt: meetingStartedAt,
        endedAt: meetingEndedAt,
      }, wallClock),
    ).toEqual(meetingStartedAt);
  });

  it("allows the post-meeting transcription flush but not beyond it", () => {
    const withinFlush = new Date(meetingEndedAt.getTime() + 30_000);
    expect(
      clampSegmentStartedAt(withinFlush.getTime(), {
        startedAt: meetingStartedAt,
        endedAt: meetingEndedAt,
      }, wallClock),
    ).toEqual(withinFlush);

    expect(
      clampSegmentStartedAt(wallClock.getTime(), {
        startedAt: meetingStartedAt,
        endedAt: meetingEndedAt,
      }, wallClock),
    ).toEqual(new Date(meetingEndedAt.getTime() + DISCONNECTED_TRANSCRIPT_GRACE_MS));
  });

  it("clamps a live meeting's future timestamp to the Worker clock", () => {
    expect(
      clampSegmentStartedAt(wallClock.getTime() + 30_000, {
        startedAt: meetingStartedAt,
        endedAt: null,
      }, wallClock),
    ).toEqual(wallClock);
  });
});

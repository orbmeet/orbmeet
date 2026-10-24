import { beforeEach, describe, expect, it } from "vitest";
import {
  meetingAdmissions,
  meetingArtifacts,
  meetingConnections,
  meetingLinks,
  meetingSummaries,
  meetings,
  spaceMembers,
  spaces,
  transcripts,
  users,
} from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";

import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import {
  resolveAutomationMeeting,
  retrieveAutomationMeeting,
} from "./meeting-retrieval";

let db: TestDb;
const startedAt = new Date("2026-07-18T09:00:00.000Z");
const endedAt = new Date("2026-07-18T09:30:00.000Z");
const transcriptUpdatedAt = new Date("2026-07-18T09:29:00.000Z");

async function insertEndedMeeting(
  id: string,
  title: string,
  start = startedAt,
  code = id === "meeting_product" ? "prd-sync-now" : "bdg-plan-now",
) {
  const end = new Date(start.getTime() + 30 * 60_000);
  await seedPersonalSpace(db, "user_owner");
  await db.insert(meetingLinks).values({
    id: `link_${id}`,
    code,
    reusePolicy: "one_time",
    spaceId: "user_owner_space",
    spaceKind: "personal" as const,
    title,
    allowGuests: true,
    joinPolicy: "open",
    createdAt: start,
    updatedAt: end,
  });
  await db.insert(meetings).values({
    id,
    meetingLinkId: `link_${id}`,
    spaceId: "user_owner_space",
    spaceKind: "personal" as const,
    title,
    startedByUserId: "user_owner",
    status: "ended",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "user_owner",
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: true,
    joinPolicy: "open",
    startedAt: start,
    endedAt: end,
    // Transcript inserts maintain these projections transactionally.
    transcriptSegmentCount: 0,
    transcriptLastIngestedAt: null,
    updatedAt: end,
  });
  await db.insert(meetingAdmissions).values({
    id: `admission_${id}`,
    meetingId: id,
    subjectType: "user",
    subjectUserId: "user_aariz",
    displayName: "Aariz Rahman",
    admissionStatus: "approved",
    decidedAt: start,
    createdAt: start,
    updatedAt: start,
  });
  // Aariz reached the room: approval alone is not attending.
  await db.insert(meetingConnections).values({
    id: `connection_${id}`,
    meetingId: id,
    admissionId: `admission_${id}`,
    livekitIdentity: `user_aariz_${id}`,
    userId: "user_aariz",
    role: "attendee",
    connectionStatus: "ended",
    tokenIssuedAt: start,
    connectedAt: start,
    disconnectedAt: end,
    createdAt: start,
    updatedAt: end,
  });
}

beforeEach(async () => {
  db = await createTestDb();
  const createdAt = new Date("2026-07-01T00:00:00.000Z");
  await db.insert(users).values([
    {
      id: "user_owner",
      name: "Atiq",
      email: "atiq@example.com",
      normalizedEmail: "atiq@example.com",
      image: null,
      plan: "pro",
      role: "user",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "user_aariz",
      name: "Aariz Rahman",
      email: "aariz@example.com",
      normalizedEmail: "aariz@example.com",
      image: null,
      plan: "free",
      role: "user",
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "user_outsider",
      name: "Outsider",
      email: "outsider@example.com",
      normalizedEmail: "outsider@example.com",
      image: null,
      plan: "free",
      role: "user",
      createdAt,
      updatedAt: createdAt,
    },
  ]);
  await insertEndedMeeting("meeting_product", "Product sync");
});

describe("automation Meeting retrieval", () => {
  it("resolves history from a local date, partial title, and participant name", async () => {
    await expect(resolveAutomationMeeting(db, "user_owner", {
      date: "2026-07-18",
      timeZone: "Asia/Dhaka",
      title: "product",
      participant: "Aariz",
      include: [],
      transcriptLimit: 500,
    })).resolves.toMatchObject({
      id: "meeting_product",
      title: "Product sync",
      participantNames: ["Aariz Rahman"],
    });
  });

  it("treats an internal Meeting ID as authoritative over stale selectors", async () => {
    await expect(resolveAutomationMeeting(db, "user_owner", {
      meetingId: "meeting_product",
      date: "2025-01-01",
      timeZone: "Asia/Dhaka",
      title: "different title",
      space: "different space",
      participant: "different participant",
      include: [],
      transcriptLimit: 500,
    })).resolves.toMatchObject({ id: "meeting_product" });
  });

  it("applies the exact local-date bounds before the result limit", async () => {
    await insertEndedMeeting(
      "meeting_older_match",
      "Bounded match",
      new Date("2026-07-18T08:00:00.000Z"),
      "old-mtch-row",
    );
    for (let index = 0; index < 50; index += 1) {
      const first = String.fromCharCode(97 + Math.floor(index / 26));
      const second = String.fromCharCode(97 + (index % 26));
      await insertEndedMeeting(
        `meeting_cap_${index}`,
        `Bounded distractor ${index}`,
        new Date(Date.parse("2026-07-18T10:01:00.000Z") + index * 60_000),
        `cap-${first}${second}aa-row`,
      );
    }

    await expect(resolveAutomationMeeting(db, "user_owner", {
      date: "2026-07-18",
      timeZone: "Pacific/Kiritimati",
      title: "Bounded",
      include: [],
      transcriptLimit: 500,
    })).resolves.toMatchObject({ id: "meeting_older_match", title: "Bounded match" });
  });

  it("requires clarification without leaking Meeting IDs", async () => {
    await insertEndedMeeting(
      "meeting_budget",
      "Budget review",
      new Date("2026-07-18T12:00:00.000Z"),
    );

    await expect(resolveAutomationMeeting(db, "user_owner", {
      date: "2026-07-18",
      timeZone: "Asia/Dhaka",
      include: [],
      transcriptLimit: 500,
    })).rejects.toMatchObject({
      code: "AMBIGUOUS_MEETING",
      data: {
        candidates: [
          expect.not.objectContaining({ id: expect.anything() }),
          expect.not.objectContaining({ id: expect.anything() }),
        ],
      },
    });
  });

  it("does not reveal inaccessible Meeting history", async () => {
    await expect(resolveAutomationMeeting(db, "user_outsider", {
      title: "Product sync",
      timeZone: "Asia/Dhaka",
      include: [],
      transcriptLimit: 500,
    })).rejects.toMatchObject({ code: "MEETING_NOT_FOUND" });
  });

  it("stops resolving a shared Meeting once Space membership ends", async () => {
    // The automation API reads through the same predicate as the dashboard, so
    // a removed member loses the Meeting here too rather than keeping a second
    // door into its transcript and summary.
    await db.insert(spaces).values({
      kind: "shared",
      id: "space_product",
      slug: "product",
      name: "Product",
      ownerUserId: "user_owner",
      organizationId: null,
      createdAt: startedAt,
      updatedAt: endedAt,
    });
    await db.insert(spaceMembers).values([
      {
        id: "membership_product_owner",
        spaceId: "space_product",
        userId: "user_owner",
        role: "admin",
        joinedAt: startedAt,
      },
      {
        id: "membership_product_attendee",
        spaceId: "space_product",
        userId: "user_aariz",
        role: "member",
        joinedAt: startedAt,
      },
    ]);
    await db.insert(meetingLinks).values({
      id: "link_shared_product",
      code: "shr-prdt-now",
      reusePolicy: "reusable",
      spaceId: "space_product",
      spaceKind: "shared",
      allowGuests: false,
      joinPolicy: "open",
      createdAt: startedAt,
      updatedAt: endedAt,
    });
    await db.insert(meetings).values({
      id: "meeting_shared_product",
      meetingLinkId: "link_shared_product",
      spaceId: "space_product",
      spaceKind: "shared",
      title: "Shared roadmap",
      startedByUserId: "user_owner",
      status: "ended",
      billingPrincipalType: "user",
      billingPrincipalId: "user_owner",
      billingPlan: "pro",
      allowGuests: false,
      recordingEnabled: true,
      joinPolicy: "open",
      startedAt,
      endedAt,
      updatedAt: endedAt,
    });
    await db.insert(meetingAdmissions).values({
      id: "admission_shared_product",
      meetingId: "meeting_shared_product",
      subjectType: "user",
      subjectUserId: "user_aariz",
      displayName: "Aariz Rahman",
      admissionStatus: "approved",
      decidedAt: startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    // While still a member of the Space, the Meeting resolves.
    await expect(resolveAutomationMeeting(db, "user_aariz", {
      meetingId: "meeting_shared_product",
      timeZone: "Asia/Dhaka",
      include: [],
      transcriptLimit: 500,
    })).resolves.toMatchObject({ id: "meeting_shared_product", spaceName: "Product" });

    await db.delete(spaceMembers).where(eq(spaceMembers.id, "membership_product_attendee"));

    // The approved admission survives removal — eviction only revokes
    // admissions on Meetings that are still open — so membership is what has to
    // answer here.
    await expect(resolveAutomationMeeting(db, "user_aariz", {
      meetingId: "meeting_shared_product",
      timeZone: "Asia/Dhaka",
      include: [],
      transcriptLimit: 500,
    })).rejects.toMatchObject({ code: "MEETING_NOT_FOUND" });
  });

  it("returns a fresh Summary and paginated transcript while reporting downloadable content", async () => {
    await db.insert(transcripts).values([
      {
        id: "transcript_1",
        meetingId: "meeting_product",
        admissionId: "admission_meeting_product",
        participantIdentity: "user_aariz",
        participantName: "Aariz Rahman",
        text: "First segment",
        segmentId: "segment_1",
        startedAt,
        updatedAt: startedAt,
      },
      {
        id: "transcript_2",
        meetingId: "meeting_product",
        admissionId: "admission_meeting_product",
        participantIdentity: "user_aariz",
        participantName: "Aariz Rahman",
        text: "Second segment",
        segmentId: "segment_2",
        startedAt: new Date(startedAt.getTime() + 1_000),
        updatedAt: transcriptUpdatedAt,
      },
    ]);
    await db.insert(meetingSummaries).values({
      id: "summary_product",
      meetingId: "meeting_product",
      summary: "A concise product discussion.",
      durationSeconds: 1800,
      participantCount: 2,
      transcribedParticipantCount: 1,
      transcriptSegmentCount: 2,
      transcriptLastUpdatedAt: transcriptUpdatedAt,
      createdAt: endedAt,
    });
    await db.insert(meetingArtifacts).values([
      {
        id: "artifact_recording",
        meetingId: "meeting_product",
        spaceId: "user_owner_space",
        type: "recording",
        r2Key: "meetings/meeting_product/recordings/eg_video.mp4",
        filename: "video.mp4",
        mimeType: "video/mp4",
        size: 100,
        uploadedByUserId: "user_owner",
        createdAt: endedAt,
      },
      {
        id: "artifact_pdf",
        meetingId: "meeting_product",
        spaceId: "user_owner_space",
        type: "whiteboard_pdf",
        r2Key: "meetings/meeting_product/exports/whiteboard.pdf",
        filename: "export.pdf",
        mimeType: "application/pdf",
        size: 50,
        uploadedByUserId: "user_owner",
        createdAt: endedAt,
      },
    ]);

    const first = await retrieveAutomationMeeting(db, {} as Env, "user_owner", {
      meetingId: "meeting_product",
      include: ["summary", "transcript"],
      transcriptLimit: 1,
    });
    expect(first).toMatchObject({
      available: { summary: true, transcript: true, recordings: true, whiteboardPdf: true },
      summary: { summary: "A concise product discussion." },
      transcript: {
        segments: [{ text: "First segment" }],
        nextCursor: expect.objectContaining({ id: "transcript_1" }),
      },
    });

    const nextCursor = (first.transcript as {
      nextCursor: { startedAt: number; id: string };
    }).nextCursor;
    await expect(retrieveAutomationMeeting(db, {} as Env, "user_owner", {
      meetingId: "meeting_product",
      include: ["transcript"],
      transcriptCursor: nextCursor,
      transcriptLimit: 1,
    })).resolves.toMatchObject({
      transcript: { segments: [{ text: "Second segment" }], nextCursor: null },
    });

    const storageEnv = {
      R2_BUCKET_NAME: "orbmeet-test",
      R2_ACCOUNT_ID: "account",
      R2_ACCESS_KEY_ID: "access-key",
      R2_SECRET_ACCESS_KEY: "secret-key",
    } as Env;
    await expect(retrieveAutomationMeeting(db, storageEnv, "user_owner", {
      meetingId: "meeting_product",
      include: ["recordings", "whiteboard_pdf"],
      transcriptLimit: 500,
    })).resolves.toMatchObject({
      recordings: [{
        filename: "video.mp4",
        downloadUrl: expect.stringContaining("account.r2.cloudflarestorage.com"),
      }],
      whiteboardPdf: {
        filename: "export.pdf",
        downloadUrl: expect.stringContaining("account.r2.cloudflarestorage.com"),
      },
    });
    await expect(retrieveAutomationMeeting(db, storageEnv, "user_aariz", {
      meetingId: "meeting_product",
      include: ["recordings"],
      transcriptLimit: 500,
    })).resolves.toMatchObject({
      available: { recordings: true, whiteboardPdf: true },
      recordings: [{
        filename: "video.mp4",
        downloadUrl: expect.stringContaining("account.r2.cloudflarestorage.com"),
      }],
    });
  });
});

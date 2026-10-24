import { seedPersonalSpace } from "@/test/fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { hashSessionToken } from "@/platform/crypto/tokens.server";
import { eq } from "drizzle-orm";
import { meetingAdmissions, meetingSummaries, meetings, meetingLinks, users } from "@orbmeet/db/schema";
import {
  assertParticipantHandoffAccess,
  getParticipantHandoffSummaryImpl,
} from "@/modules/transcripts/server/participant-handoff.server";

const authMocks = vi.hoisted(() => ({
  getGuestCookieSecret: vi.fn(),
}));

vi.mock("@/modules/meetings/server/access/guest-cookie.server", () => ({
  getGuestCookieSecret: authMocks.getGuestCookieSecret,
}));

let db: TestDb;
const getAppDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
  authMocks.getGuestCookieSecret.mockReset();
});

async function insertHostAndMeeting(meetingId: string) {
  const now = new Date();
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
    id: `room_${meetingId}`,
    code: "abc-defg-hij",
    spaceId: "host_space",
    spaceKind: "personal" as const,
    title: "Meeting",
    allowGuests: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: meetingId,
    meetingLinkId: `room_${meetingId}`,
    spaceId: "host_space",
    spaceKind: "personal" as const,
    startedByUserId: "host",
    title: "Meeting",
    status: "ended",
    billingPrincipalType: "user" as const,
    billingPrincipalId: "host",
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    startedAt: now,
    endedAt: now,
    updatedAt: now,
  });
}

async function insertGuestAdmission(
  meetingId: string,
  admissionStatus: "approved" | "pending" | "denied" | "revoked",
  secret = "guest-secret",
) {
  const now = new Date();
  await db.insert(meetingAdmissions).values({
    id: `admission_${admissionStatus}`,
    meetingId: meetingId,
    subjectType: "guest",
    subjectUserId: null,
    guestSecretHash: await hashSessionToken(secret),
    displayName: "Guest",
    admissionStatus,
    decidedAt: admissionStatus === "pending" ? null : now,
    createdAt: now,
    updatedAt: now,
  });
  return `admission_${admissionStatus}`;
}

describe("participant handoff access", () => {
  it("allows an approved guest with the matching admission cookie", async () => {
    await insertHostAndMeeting("meeting_1");
    const admissionId = await insertGuestAdmission("meeting_1", "approved");
    authMocks.getGuestCookieSecret.mockReturnValue("guest-secret");

    await expect(
      assertParticipantHandoffAccess(getAppDb(), null, "meeting_1", admissionId),
    ).resolves.toBeUndefined();
  });

  it("allows an approved guest only through the occurrence-specific HttpOnly cookie", async () => {
    await insertHostAndMeeting("meeting_1");
    const admissionId = await insertGuestAdmission("meeting_1", "approved");
    authMocks.getGuestCookieSecret.mockReturnValue("guest-secret");

    await expect(
      assertParticipantHandoffAccess(getAppDb(), null, "meeting_1", admissionId),
    ).resolves.toBeUndefined();
    authMocks.getGuestCookieSecret.mockReturnValue("wrong-secret");
    await expect(
      assertParticipantHandoffAccess(getAppDb(), null, "meeting_1", admissionId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("still admits the guest after they sign in on the same browser", async () => {
    await insertHostAndMeeting("meeting_1");
    const admissionId = await insertGuestAdmission("meeting_1", "approved");
    await db.insert(users).values({
      id: "former_guest",
      name: "Former Guest",
      email: "former-guest@example.com",
      normalizedEmail: "former-guest@example.com",
      image: null,
      plan: "free",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const signedIn = { id: "former_guest" };

    authMocks.getGuestCookieSecret.mockReturnValue("guest-secret");
    await expect(
      assertParticipantHandoffAccess(getAppDb(), signedIn, "meeting_1", admissionId),
    ).resolves.toBeUndefined();

    authMocks.getGuestCookieSecret.mockReturnValue(null);
    await expect(
      assertParticipantHandoffAccess(getAppDb(), signedIn, "meeting_1", admissionId),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it.each(["pending", "denied", "revoked"] as const)(
    "denies a %s guest even when the admission cookie still matches",
    async (admissionStatus) => {
      await insertHostAndMeeting("meeting_1");
      const admissionId = await insertGuestAdmission("meeting_1", admissionStatus);
      authMocks.getGuestCookieSecret.mockReturnValue("guest-secret");

      await expect(
        assertParticipantHandoffAccess(getAppDb(), null, "meeting_1", admissionId),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );
});

describe("participant handoff summary", () => {
  const env = {
    AI_API_KEY: "test-key",
    AI_MODEL: "test-model",
    APP_URL: "http://localhost:3000",
    ENVIRONMENT: "development",
  } as unknown as Env;
  const transcriptAt = new Date(Date.now() - 60_000);

  async function seed(summaryStatus: "pending" | "settled" | "failed", summarizedSegments: number) {
    await insertHostAndMeeting("meeting_1");
    await db.update(meetings)
      .set({ summaryStatus, transcriptSegmentCount: 60, transcriptLastIngestedAt: transcriptAt })
      .where(eq(meetings.id, "meeting_1"));
    await db.insert(meetingSummaries).values({
      id: "summary_1",
      meetingId: "meeting_1",
      summary: "What was said.",
      durationSeconds: 120,
      participantCount: 2,
      transcribedParticipantCount: 1,
      transcriptSegmentCount: summarizedSegments,
      transcriptLastUpdatedAt: transcriptAt,
      createdAt: transcriptAt,
    });
  }

  const read = () => getParticipantHandoffSummaryImpl({
    data: { meetingId: "meeting_1", admissionId: "admission_unused" },
    context: { env, db, user: { id: "host" }, clientIP: "127.0.0.1" },
  } as never);

  it.each(["settled", "failed"] as const)(
    "is unavailable when the Summary is %s for a transcript its row predates",
    async (summaryStatus) => {
      // A summary of the first five segments; the transcript has since grown
      // and regeneration reached a final outcome.
      await seed(summaryStatus, 5);
      await expect(read()).resolves.toMatchObject({ status: "unavailable", summary: null });
    },
  );

  it("is pending while a Summary of the grown transcript is still owed", async () => {
    await seed("pending", 5);
    await expect(read()).resolves.toMatchObject({ status: "pending", summary: null });
  });

  it("is ready when the row summarizes the transcript as it stands", async () => {
    await seed("settled", 60);
    await expect(read()).resolves.toMatchObject({ status: "ready", summary: { id: "summary_1" } });
  });
});


import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import {
  meetingAdmissions,
  meetingLinks,
  meetings,
  spaceMembers,
  users,
} from "@orbmeet/db/schema";
import { sql } from "drizzle-orm";
import { seedPersonalSpace, seedSharedSpace } from "@/test/fixtures";
import { createLiveKitAccess } from "@/modules/meetings/server/livekit-token.server";
import { publishSourcesFor as getMeetingRolePublishSources } from "@/modules/meetings/server/runtime/effects.server";
import { TrackSource } from "livekit-server-sdk";
import { canAccessMeetingHistory } from "@/modules/meetings/server/access/resource-access";
import { verifyGuestAdmissionBySecret } from "@/modules/meetings/server/access/guest-admission";
import { hashSessionToken } from "@/platform/crypto/tokens.server";
import { decodeJwt } from "jose";

let db: TestDb;
const generateGuestSecret = () => crypto.randomUUID();
const hashGuestSecret = hashSessionToken;

beforeEach(async () => {
  db = await createTestDb();
});

async function seedUser(id: string, name = id) {
  const now = new Date();
  await db.insert(users).values({
    id,
    name,
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
}

describe("Adversarial Stress Testing: Meeting Admission, Token Scoping & Guest Isolation", () => {
  describe("1. Guest Isolation Database Check Constraints Under Mutation Attempts", () => {
    it("rejects raw SQL UPDATE attempting to enable allow_guests on a shared space meeting link", async () => {
      await seedUser("usr_adv_link_owner");
      const spaceId = await seedSharedSpace(db, {
        id: "space_adv_links",
        ownerUserId: "usr_adv_link_owner",
        slug: "adv-links",
        members: [{ userId: "usr_adv_link_owner", role: "owner" }],
      });

      const now = new Date();
      await db.insert(meetingLinks).values({
        id: "link_adv_shared_1",
        code: "adv-shra-lnk",
        spaceId,
        spaceKind: "shared",
        title: "Shared Link",
        allowGuests: false,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      });

      // Raw SQL UPDATE attempting to bypass check constraint
      await expect(
        db.run(
          sql`UPDATE meeting_links SET allow_guests = 1 WHERE id = 'link_adv_shared_1'`,
        ),
      ).rejects.toThrow();
    });

    it("rejects raw SQL UPDATE attempting to enable allow_guests on a shared space meeting", async () => {
      await seedUser("usr_adv_meet_owner");
      const spaceId = await seedSharedSpace(db, {
        id: "space_adv_meets",
        ownerUserId: "usr_adv_meet_owner",
        slug: "adv-meets",
        members: [{ userId: "usr_adv_meet_owner", role: "owner" }],
      });

      const now = new Date();
      await db.insert(meetingLinks).values({
        id: "link_adv_shared_2",
        code: "adv-shra-mtg",
        spaceId,
        spaceKind: "shared",
        title: "Shared Link 2",
        allowGuests: false,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(meetings).values({
        id: "meet_adv_shared_1",
        meetingLinkId: "link_adv_shared_2",
        spaceId,
        spaceKind: "shared",
        title: "Shared Meeting",
        startedByUserId: "usr_adv_meet_owner",
        status: "open",
        billingPrincipalType: "user",
        billingPrincipalId: "usr_adv_meet_owner",
        billingPlan: "free",
        allowGuests: false,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: now,
        updatedAt: now,
      });

      // Raw SQL UPDATE attempting to enable allow_guests on shared space meeting
      await expect(
        db.run(
          sql`UPDATE meetings SET allow_guests = 1 WHERE id = 'meet_adv_shared_1'`,
        ),
      ).rejects.toThrow();
    });

    it("rejects mutating space_kind from personal to shared on a meeting with allow_guests = 1", async () => {
      await seedUser("usr_adv_p_owner");
      const personalSpaceId = await seedPersonalSpace(db, "usr_adv_p_owner");
      const sharedSpaceId = await seedSharedSpace(db, {
        id: "space_adv_target_shared",
        ownerUserId: "usr_adv_p_owner",
        slug: "adv-target-shared",
        members: [{ userId: "usr_adv_p_owner", role: "owner" }],
      });

      const now = new Date();
      await db.insert(meetingLinks).values({
        id: "link_adv_p_1",
        code: "adv-pera-lnk",
        spaceId: personalSpaceId,
        spaceKind: "personal",
        title: "Personal Guest Link",
        allowGuests: true,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      });

      // Attempting to change space_kind to 'shared' while allow_guests remains 1
      await expect(
        db.run(
          sql`UPDATE meeting_links SET space_kind = 'shared', space_id = ${sharedSpaceId} WHERE id = 'link_adv_p_1'`,
        ),
      ).rejects.toThrow();
    });
  });

  describe("2. LiveKit Token Scoping & Privilege Escalation Resistance", () => {
    const mockApiKey = "API_KEY_TEST_M4_ADVERSARIAL";
    const mockApiSecret = "API_SECRET_TEST_M4_ADVERSARIAL_1234567890";

    it("enforces strict grant scoping: roomAdmin is false, canUpdateOwnMetadata is false, exact room binding", async () => {
      const roomName = "room_adv_scope_1";
      const identity = "usr_adversary_1";

      const { token, expiresIn } = await createLiveKitAccess({
        apiKey: mockApiKey,
        apiSecret: mockApiSecret,
        identity,
        name: "Adversary Participant",
        roomName,
        attributes: { "orbmeet.role": "attendee" },
        canPublishSources: getMeetingRolePublishSources("attendee", false),
      });

      expect(expiresIn).toBe(300); // 5 minutes TTL

      const decoded = decodeJwt<{
        sub: string;
        video: {
          room: string;
          roomJoin: boolean;
          roomAdmin: boolean;
          canPublish: boolean;
          canSubscribe: boolean;
          canUpdateOwnMetadata: boolean;
          canPublishSources: string[];
        };
      }>(token);

      expect(decoded.sub).toBe("usr_adversary_1");
      expect(decoded.video.room).toBe("room_adv_scope_1");
      expect(decoded.video.roomJoin).toBe(true);
      expect(decoded.video.roomAdmin).toBe(false); // Security invariant: NEVER true
      expect(decoded.video.canUpdateOwnMetadata).toBe(false); // Cannot alter server-written attributes
      expect(decoded.video.canPublishSources).toEqual([
        "camera",
        "microphone",
      ]);
      expect(decoded.video.canPublishSources).not.toContain("screen_share");
    });

    it("restricts screen share tracks: granted only when screenShareGranted = true or moderation role", () => {
      const regularAttendeeSources = getMeetingRolePublishSources("attendee", false);
      expect(regularAttendeeSources).not.toContain(TrackSource.SCREEN_SHARE);
      expect(regularAttendeeSources).not.toContain(TrackSource.SCREEN_SHARE_AUDIO);

      const approvedAttendeeSources = getMeetingRolePublishSources("attendee", true);
      expect(approvedAttendeeSources).toContain(TrackSource.SCREEN_SHARE);
      expect(approvedAttendeeSources).toContain(TrackSource.SCREEN_SHARE_AUDIO);

      const moderatorSources = getMeetingRolePublishSources("moderator", false);
      expect(moderatorSources).toContain(TrackSource.SCREEN_SHARE);
      expect(moderatorSources).toContain(TrackSource.SCREEN_SHARE_AUDIO);
    });
  });

  describe("3. Guest Cookie & Secret Cryptographic Forgery Stress", () => {
    it("rejects forged, truncated, or missing guest secrets with UNAUTHORIZED / FORBIDDEN", async () => {
      await seedUser("usr_adv_host_guest");
      const spaceId = await seedPersonalSpace(db, "usr_adv_host_guest");
      const now = new Date();

      await db.insert(meetingLinks).values({
        id: "link_adv_guest_sec",
        code: "adv-gsta-sec",
        spaceId,
        spaceKind: "personal",
        allowGuests: true,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(meetings).values({
        id: "meet_adv_guest_sec",
        meetingLinkId: "link_adv_guest_sec",
        spaceId,
        spaceKind: "personal",
        startedByUserId: "usr_adv_host_guest",
        status: "open",
        billingPrincipalType: "user",
        billingPrincipalId: "usr_adv_host_guest",
        billingPlan: "free",
        allowGuests: true,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: now,
        updatedAt: now,
      });

      const genuineSecret = generateGuestSecret();
      const genuineSecretHash = await hashGuestSecret(genuineSecret);

      await db.insert(meetingAdmissions).values({
        id: "adm_adv_genuine_guest",
        meetingId: "meet_adv_guest_sec",
        subjectType: "guest",
        subjectUserId: null,
        guestSecretHash: genuineSecretHash,
        displayName: "Legit Guest",
        admissionStatus: "approved",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // 1. Missing secret (null) -> 401 UNAUTHORIZED
      await expect(
        verifyGuestAdmissionBySecret(db, "meet_adv_guest_sec", "adm_adv_genuine_guest", null),
      ).rejects.toThrow();

      // 2. Empty string secret -> 401 UNAUTHORIZED
      await expect(
        verifyGuestAdmissionBySecret(db, "meet_adv_guest_sec", "adm_adv_genuine_guest", ""),
      ).rejects.toThrow();

      // 3. Forged random secret -> 403 FORBIDDEN
      const forgedSecret = generateGuestSecret();
      await expect(
        verifyGuestAdmissionBySecret(
          db,
          "meet_adv_guest_sec",
          "adm_adv_genuine_guest",
          forgedSecret,
        ),
      ).rejects.toThrow();

      // 4. Truncated secret -> 403 FORBIDDEN
      await expect(
        verifyGuestAdmissionBySecret(
          db,
          "meet_adv_guest_sec",
          "adm_adv_genuine_guest",
          genuineSecret.slice(0, 16),
        ),
      ).rejects.toThrow();

      // 5. Genuine secret -> Resolves admission record
      const admission = await verifyGuestAdmissionBySecret(
        db,
        "meet_adv_guest_sec",
        "adm_adv_genuine_guest",
        genuineSecret,
      );
      expect(admission.id).toBe("adm_adv_genuine_guest");
      expect(admission.displayName).toBe("Legit Guest");
    });

    it("rejects guest secret when targeting a registered user admission row", async () => {
      await seedUser("usr_adv_registered_participant");
      const spaceId = await seedPersonalSpace(db, "usr_adv_registered_participant");
      const now = new Date();

      await db.insert(meetingLinks).values({
        id: "link_adv_u_sec",
        code: "adv-usra-sec",
        spaceId,
        spaceKind: "personal",
        allowGuests: true,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(meetings).values({
        id: "meet_adv_u_sec",
        meetingLinkId: "link_adv_u_sec",
        spaceId,
        spaceKind: "personal",
        startedByUserId: "usr_adv_registered_participant",
        status: "open",
        billingPrincipalType: "user",
        billingPrincipalId: "usr_adv_registered_participant",
        billingPlan: "free",
        allowGuests: true,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: now,
        updatedAt: now,
      });

      const secret = generateGuestSecret();

      // Admission has subjectType = 'user' and subjectUserId populated
      await db.insert(meetingAdmissions).values({
        id: "adm_adv_user_subject",
        meetingId: "meet_adv_u_sec",
        subjectType: "user",
        subjectUserId: "usr_adv_registered_participant",
        guestSecretHash: null,
        displayName: "User Subject",
        admissionStatus: "approved",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // Invariant: verifyGuestAdmissionBySecret requires subjectType = 'guest' and subjectUserId IS NULL
      await expect(
        verifyGuestAdmissionBySecret(
          db,
          "meet_adv_u_sec",
          "adm_adv_user_subject",
          secret,
        ),
      ).rejects.toThrow();
    });

    it("rejects cross-meeting replay attacks with guest secrets", async () => {
      await seedUser("usr_adv_replay_host");
      const spaceId = await seedPersonalSpace(db, "usr_adv_replay_host");
      const now = new Date();

      await db.insert(meetingLinks).values([
        {
          id: "link_adv_replay_1",
          code: "adv-rpya-lna",
          spaceId,
          spaceKind: "personal",
          allowGuests: true,
          joinPolicy: "open",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "link_adv_replay_2",
          code: "adv-rpya-lnb",
          spaceId,
          spaceKind: "personal",
          allowGuests: true,
          joinPolicy: "open",
          createdAt: now,
          updatedAt: now,
        },
      ]);

      // Meeting 1
      await db.insert(meetings).values({
        id: "meet_adv_replay_1",
        meetingLinkId: "link_adv_replay_1",
        spaceId,
        spaceKind: "personal",
        startedByUserId: "usr_adv_replay_host",
        status: "open",
        billingPrincipalType: "user",
        billingPrincipalId: "usr_adv_replay_host",
        billingPlan: "free",
        allowGuests: true,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: now,
        updatedAt: now,
      });

      // Meeting 2
      await db.insert(meetings).values({
        id: "meet_adv_replay_2",
        meetingLinkId: "link_adv_replay_2",
        spaceId,
        spaceKind: "personal",
        startedByUserId: "usr_adv_replay_host",
        status: "open",
        billingPrincipalType: "user",
        billingPrincipalId: "usr_adv_replay_host",
        billingPlan: "free",
        allowGuests: true,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: now,
        updatedAt: now,
      });

      const secret = generateGuestSecret();
      const secretHash = await hashGuestSecret(secret);

      // Admission only created for Meeting 1
      await db.insert(meetingAdmissions).values({
        id: "adm_adv_meet1",
        meetingId: "meet_adv_replay_1",
        subjectType: "guest",
        subjectUserId: null,
        guestSecretHash: secretHash,
        displayName: "Guest Meet 1",
        admissionStatus: "approved",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // Attempting to use admission and secret against Meeting 2 fails
      await expect(
        verifyGuestAdmissionBySecret(
          db,
          "meet_adv_replay_2",
          "adm_adv_meet1",
          secret,
        ),
      ).rejects.toThrow();
    });
  });

  describe("4. Post-Meeting History Access Predicate (canAccessMeetingHistory) IDOR Stress", () => {
    it("strictly isolates ended meeting history across space boundaries, former members, and unadmitted outsiders", async () => {
      await seedUser("usr_space_a_owner");
      await seedUser("usr_space_a_member");
      await seedUser("usr_space_a_demoted");
      await seedUser("usr_space_b_member");
      await seedUser("usr_approved_guest");
      await seedUser("usr_rejected_guest");
      await seedUser("usr_pending_guest");
      await seedUser("usr_unadmitted_outsider");

      const spaceA = await seedSharedSpace(db, {
        id: "space_adv_a",
        ownerUserId: "usr_space_a_owner",
        slug: "adv-space-a",
        members: [
          { userId: "usr_space_a_owner", role: "owner" },
          { userId: "usr_space_a_member", role: "member" },
          { userId: "usr_space_a_demoted", role: "member" },
        ],
      });

      await seedSharedSpace(db, {
        id: "space_adv_b",
        ownerUserId: "usr_space_b_member",
        slug: "adv-space-b",
        members: [{ userId: "usr_space_b_member", role: "owner" }],
      });

      const now = new Date();
      await db.insert(meetingLinks).values({
        id: "link_adv_hist_a",
        code: "adv-hsta-lnk",
        spaceId: spaceA,
        spaceKind: "shared",
        allowGuests: false,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(meetings).values({
        id: "meet_adv_ended_a",
        meetingLinkId: "link_adv_hist_a",
        spaceId: spaceA,
        spaceKind: "shared",
        startedByUserId: "usr_space_a_owner",
        status: "ended",
        billingPrincipalType: "user",
        billingPrincipalId: "usr_space_a_owner",
        billingPlan: "free",
        allowGuests: false,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: now,
        endedAt: now,
        updatedAt: now,
      });

      // External admissions for users
      // 1. Approved attendee
      await db.insert(meetingAdmissions).values({
        id: "adm_usr_approved",
        meetingId: "meet_adv_ended_a",
        subjectType: "user",
        subjectUserId: "usr_approved_guest",
        displayName: "Approved User",
        admissionStatus: "approved",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // 2. Rejected attendee
      await db.insert(meetingAdmissions).values({
        id: "adm_usr_rejected",
        meetingId: "meet_adv_ended_a",
        subjectType: "user",
        subjectUserId: "usr_rejected_guest",
        displayName: "Rejected User",
        admissionStatus: "denied",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // 4. The member who is about to be removed really attended, so they hold
      //    an approved admission on this now-ended meeting. Removal does not
      //    revoke it (eviction only touches `open` meetings), which is exactly
      //    why assertion 3 below has to be answered by membership, not by the
      //    admission row.
      await db.insert(meetingAdmissions).values({
        id: "adm_usr_demoted",
        meetingId: "meet_adv_ended_a",
        subjectType: "user",
        subjectUserId: "usr_space_a_demoted",
        displayName: "Demoted Member",
        admissionStatus: "approved",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // 3. Pending attendee
      await db.insert(meetingAdmissions).values({
        id: "adm_usr_pending",
        meetingId: "meet_adv_ended_a",
        subjectType: "user",
        subjectUserId: "usr_pending_guest",
        displayName: "Pending User",
        admissionStatus: "pending",
        decidedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      // Remove the demoted member from spaceA
      await db
        .delete(spaceMembers)
        .where(
          sql`${spaceMembers.spaceId} = ${spaceA} AND ${spaceMembers.userId} = 'usr_space_a_demoted'`,
        );

      // --- Assertions ---
      // 1. Space Owner has access
      expect(await canAccessMeetingHistory(db, "meet_adv_ended_a", "usr_space_a_owner")).toBe(true);

      // 2. Active Space Member has access
      expect(await canAccessMeetingHistory(db, "meet_adv_ended_a", "usr_space_a_member")).toBe(true);

      // 3. Removed member from space A has NO access — despite still holding an
      //    approved admission from when they attended.
      expect(await canAccessMeetingHistory(db, "meet_adv_ended_a", "usr_space_a_demoted")).toBe(false);

      // 4. Member of different space (Space B) CANNOT access Space A meeting
      expect(await canAccessMeetingHistory(db, "meet_adv_ended_a", "usr_space_b_member")).toBe(false);

      // 5. An approved admission is NOT a second key to a shared-Space meeting.
      //    `joinMeeting` gates shared meetings on membership, so this row can
      //    only exist for someone who has since lost it — the same state as
      //    assertion 3, and it must answer the same way.
      expect(await canAccessMeetingHistory(db, "meet_adv_ended_a", "usr_approved_guest")).toBe(false);

      // 6. Rejected external attendee CANNOT access
      expect(await canAccessMeetingHistory(db, "meet_adv_ended_a", "usr_rejected_guest")).toBe(false);

      // 7. Pending external attendee CANNOT access
      expect(await canAccessMeetingHistory(db, "meet_adv_ended_a", "usr_pending_guest")).toBe(false);

      // 8. Non-member outsider with no admission CANNOT access
      expect(await canAccessMeetingHistory(db, "meet_adv_ended_a", "usr_unadmitted_outsider")).toBe(false);
    });
  });
});

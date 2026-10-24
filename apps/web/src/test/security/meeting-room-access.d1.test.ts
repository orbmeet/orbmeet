import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import {
  meetingAdmissions,
  meetingConnections,
  meetingLinks,
  meetings,
  spaceMembers,
  users,
} from "@orbmeet/db/schema";
import { and, eq } from "drizzle-orm";
import { seedPersonalSpace, seedSharedSpace } from "@/test/fixtures";
import { createLiveKitAccess } from "@/modules/meetings/server/livekit-token.server";
import { publishSourcesFor as getMeetingRolePublishSources } from "@/modules/meetings/server/runtime/effects.server";
import { TrackSource } from "livekit-server-sdk";
import { canAccessMeetingHistory } from "@/modules/meetings/server/access/resource-access";
import { decodeJwt } from "jose";

let db: TestDb;

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

describe("Empirical Meeting Room Access & Isolation Verification", () => {
  describe("a. Guest Exclusion from Shared Spaces (meetings_guest_entry_check)", () => {
    it("enforces meeting_links_guest_entry_check: rejects shared space link with allowGuests = 1", async () => {
      await seedUser("usr_space_owner_1");
      const spaceId = await seedSharedSpace(db, {
        id: "space_links_guest_check",
        ownerUserId: "usr_space_owner_1",
        slug: "links-guest-check",
        members: [{ userId: "usr_space_owner_1", role: "owner" }],
      });

      const now = new Date();
      // Inserting a meeting link on a shared space with allowGuests = true must violate check constraint
      await expect(
        db.insert(meetingLinks).values({
          id: "link_invalid_guest_shared",
          code: "abc-defg-hij",
          spaceId,
          spaceKind: "shared",
          title: "Invalid Shared Guest Link",
          allowGuests: true, // Forbidden on shared spaces!
          joinPolicy: "open",
          createdAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow();
    });

    it("enforces meetings_guest_entry_check: rejects shared space meeting with allowGuests = 1", async () => {
      await seedUser("usr_space_owner_2");
      const spaceId = await seedSharedSpace(db, {
        id: "space_meetings_guest_check",
        ownerUserId: "usr_space_owner_2",
        slug: "meetings-guest-check",
        members: [{ userId: "usr_space_owner_2", role: "owner" }],
      });

      const now = new Date();
      // Seed a valid meeting link (allowGuests = false)
      await db.insert(meetingLinks).values({
        id: "link_valid_shared",
        code: "klm-nopq-rst",
        spaceId,
        spaceKind: "shared",
        title: "Valid Shared Link",
        allowGuests: false,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      });

      // Attempting to start a meeting on a shared space with allowGuests = true must violate check constraint
      await expect(
        db.insert(meetings).values({
          id: "meeting_invalid_guest_shared",
          meetingLinkId: "link_valid_shared",
          spaceId,
          spaceKind: "shared",
          title: "Invalid Shared Guest Meeting",
          startedByUserId: "usr_space_owner_2",
          status: "open",
          billingPrincipalType: "user",
          billingPrincipalId: "usr_space_owner_2",
          billingPlan: "free",
          allowGuests: true, // Forbidden on shared spaces!
          recordingEnabled: false,
          joinPolicy: "open",
          startedAt: now,
          updatedAt: now,
        }),
      ).rejects.toThrow();
    });

    it("allows allowGuests = 1 on personal spaces", async () => {
      await seedUser("usr_personal_guest_owner");
      const spaceId = await seedPersonalSpace(db, "usr_personal_guest_owner");
      const now = new Date();

      await db.insert(meetingLinks).values({
        id: "link_valid_personal_guest",
        code: "uvw-xyza-bcd",
        spaceId,
        spaceKind: "personal",
        title: "Valid Personal Guest Link",
        allowGuests: true,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      });

      await expect(
        db.insert(meetings).values({
          id: "meeting_valid_personal_guest",
          meetingLinkId: "link_valid_personal_guest",
          spaceId,
          spaceKind: "personal",
          title: "Valid Personal Guest Meeting",
          startedByUserId: "usr_personal_guest_owner",
          status: "open",
          billingPrincipalType: "user",
          billingPrincipalId: "usr_personal_guest_owner",
          billingPlan: "free",
          allowGuests: true,
          recordingEnabled: false,
          joinPolicy: "open",
          startedAt: now,
          updatedAt: now,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe("b. LiveKit Admission Token Scoping & Identity Isolation", () => {
    const mockApiKey = "API_KEY_TEST_12345678";
    const mockApiSecret = "API_SECRET_TEST_123456789012345678901234567890";

    it("scopes participant token to exact room and strips roomAdmin & metadata mutation capabilities", async () => {
      const roomName = "room_meet_test_1";
      const participantIdentity = "guest_adm_999";
      const { token } = await createLiveKitAccess({
        apiKey: mockApiKey,
        apiSecret: mockApiSecret,
        identity: participantIdentity,
        name: "Guest Bob",
        roomName,
        attributes: { "orbmeet.role": "attendee" },
        canPublishSources: getMeetingRolePublishSources("attendee", false),
      });

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

      expect(decoded.sub).toBe("guest_adm_999");
      expect(decoded.video.room).toBe("room_meet_test_1");
      expect(decoded.video.roomJoin).toBe(true);
      expect(decoded.video.roomAdmin).toBe(false); // Security: roomAdmin is strictly false
      expect(decoded.video.canUpdateOwnMetadata).toBe(false); // Security: cannot tamper with own role attribute
    });

    it("restricts attendee publish sources to Camera and Microphone, excluding Screen Share unless granted", () => {
      const regularAttendeeSources = getMeetingRolePublishSources("attendee", false);
      expect(regularAttendeeSources).toEqual([TrackSource.CAMERA, TrackSource.MICROPHONE]);
      expect(regularAttendeeSources).not.toContain(TrackSource.SCREEN_SHARE);

      const attendeeWithScreenShare = getMeetingRolePublishSources("attendee", true);
      expect(attendeeWithScreenShare).toContain(TrackSource.SCREEN_SHARE);
      expect(attendeeWithScreenShare).toContain(TrackSource.SCREEN_SHARE_AUDIO);

      const hostSources = getMeetingRolePublishSources("host", false);
      expect(hostSources).toContain(TrackSource.SCREEN_SHARE);
      expect(hostSources).toContain(TrackSource.SCREEN_SHARE_AUDIO);
    });
  });

  describe("d. Post-Meeting Resource Authorization & IDOR Prevention", () => {
    it("allows space members to access ended meeting history in their space", async () => {
      await seedUser("usr_space_member_1");
      await seedUser("usr_space_member_2");
      const spaceId = await seedSharedSpace(db, {
        id: "space_idor_1",
        ownerUserId: "usr_space_member_1",
        slug: "idor-1",
        members: [
          { userId: "usr_space_member_1", role: "owner" },
          { userId: "usr_space_member_2", role: "member" },
        ],
      });

      const now = new Date();
      await db.insert(meetingLinks).values({
        id: "link_idor_1",
        code: "ido-rabc-def",
        spaceId,
        spaceKind: "shared",
        allowGuests: false,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(meetings).values({
        id: "meet_ended_1",
        meetingLinkId: "link_idor_1",
        spaceId,
        spaceKind: "shared",
        startedByUserId: "usr_space_member_1",
        status: "ended",
        billingPrincipalType: "user",
        billingPrincipalId: "usr_space_member_1",
        billingPlan: "free",
        allowGuests: false,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: now,
        endedAt: now,
        updatedAt: now,
      });

      // Space members can access
      expect(await canAccessMeetingHistory(db, "meet_ended_1", "usr_space_member_1")).toBe(true);
      expect(await canAccessMeetingHistory(db, "meet_ended_1", "usr_space_member_2")).toBe(true);
    });

    it("blocks non-members who were not attendees from accessing ended meeting history (IDOR defense)", async () => {
      await seedUser("usr_space_owner_idor2");
      await seedUser("usr_outsider");
      const spaceId = await seedSharedSpace(db, {
        id: "space_idor_2",
        ownerUserId: "usr_space_owner_idor2",
        slug: "idor-2",
        members: [{ userId: "usr_space_owner_idor2", role: "owner" }],
      });
      const now = new Date();
      await db.insert(meetingLinks).values({
        id: "link_idor_2",
        code: "ido-rxyz-uvw",
        spaceId,
        spaceKind: "shared",
        allowGuests: false,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(meetings).values({
        id: "meet_ended_2",
        meetingLinkId: "link_idor_2",
        spaceId,
        spaceKind: "shared",
        startedByUserId: "usr_space_owner_idor2",
        status: "ended",
        billingPrincipalType: "user",
        billingPrincipalId: "usr_space_owner_idor2",
        billingPlan: "free",
        allowGuests: false,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: now,
        endedAt: now,
        updatedAt: now,
      });

      // "usr_outsider" is not in space_idor_2 and was not an admitted attendee
      expect(await canAccessMeetingHistory(db, "meet_ended_2", "usr_outsider")).toBe(false);
    });

    it("permits a non-member approved attendee of a personal-Space meeting", async () => {
      await seedUser("usr_personal_host");
      await seedUser("usr_guest_attendee");
      const spaceId = await seedPersonalSpace(db, "usr_personal_host", {
        spaceId: "space_idor_3",
      });
      const now = new Date();
      await db.insert(meetingLinks).values({
        id: "link_idor_3",
        code: "ido-rghi-jkl",
        spaceId,
        spaceKind: "personal",
        allowGuests: true,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(meetings).values({
        id: "meet_ended_3",
        meetingLinkId: "link_idor_3",
        spaceId,
        spaceKind: "personal",
        startedByUserId: "usr_personal_host",
        status: "ended",
        billingPrincipalType: "user",
        billingPrincipalId: "usr_personal_host",
        billingPlan: "free",
        allowGuests: true,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: now,
        endedAt: now,
        updatedAt: now,
      });

      // A personal Space has exactly one member, so attendance is the only
      // record that this user was there — and it is the whole policy.
      await db.insert(meetingAdmissions).values({
        id: "adm_external_user",
        meetingId: "meet_ended_3",
        subjectType: "user",
        subjectUserId: "usr_guest_attendee",
        displayName: "Guest Attendee",
        admissionStatus: "approved",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(meetingConnections).values({
        id: "conn_external_user",
        meetingId: "meet_ended_3",
        admissionId: "adm_external_user",
        livekitIdentity: "usr_guest_attendee_conn",
        userId: "usr_guest_attendee",
        role: "attendee",
        connectionStatus: "ended",
        tokenIssuedAt: now,
        connectedAt: now,
        disconnectedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      expect(await canAccessMeetingHistory(db, "meet_ended_3", "usr_guest_attendee")).toBe(true);
    });

    it("revokes ended-meeting history when a shared-Space member is removed", async () => {
      await seedUser("usr_space_owner_idor4");
      await seedUser("usr_former_member");
      const spaceId = await seedSharedSpace(db, {
        id: "space_idor_4",
        ownerUserId: "usr_space_owner_idor4",
        slug: "idor-4",
        members: [
          { userId: "usr_space_owner_idor4", role: "owner" },
          { userId: "usr_former_member", role: "member" },
        ],
      });
      const now = new Date();
      await db.insert(meetingLinks).values({
        id: "link_idor_4",
        code: "ido-rmno-pqr",
        spaceId,
        spaceKind: "shared",
        allowGuests: false,
        joinPolicy: "open",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(meetings).values({
        id: "meet_ended_4",
        meetingLinkId: "link_idor_4",
        spaceId,
        spaceKind: "shared",
        startedByUserId: "usr_space_owner_idor4",
        status: "ended",
        billingPrincipalType: "user",
        billingPrincipalId: "usr_space_owner_idor4",
        billingPlan: "free",
        allowGuests: false,
        recordingEnabled: false,
        joinPolicy: "open",
        startedAt: now,
        endedAt: now,
        updatedAt: now,
      });
      await db.insert(meetingAdmissions).values({
        id: "adm_former_member",
        meetingId: "meet_ended_4",
        subjectType: "user",
        subjectUserId: "usr_former_member",
        displayName: "Former Member",
        admissionStatus: "approved",
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // While a member, they can read the history of a meeting they attended.
      expect(await canAccessMeetingHistory(db, "meet_ended_4", "usr_former_member")).toBe(true);

      await db
        .delete(spaceMembers)
        .where(and(
          eq(spaceMembers.spaceId, spaceId),
          eq(spaceMembers.userId, "usr_former_member"),
        ));

      // Eviction leaves the admission `approved` (it only revokes admissions on
      // `open` meetings), so membership has to be what answers here.
      const [admission] = await db
        .select({ status: meetingAdmissions.admissionStatus })
        .from(meetingAdmissions)
        .where(eq(meetingAdmissions.id, "adm_former_member"));
      expect(admission?.status).toBe("approved");
      expect(await canAccessMeetingHistory(db, "meet_ended_4", "usr_former_member")).toBe(false);
    });
  });
});

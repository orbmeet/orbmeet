import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Database } from "@orbmeet/db";
import {
  meetingAdmissions,
  meetingConnections,
  meetingLinks,
  meetings,
  organizations,
  spaceMembers,
  spaces,
  users,
} from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { evictUserFromSpaceMeetings } from "./evict-space-meetings.server";
import { refreshSpaceAuthorityInOpenMeetings } from "@/modules/meetings/server/runtime/revoke.server";
import { TEST_MEDIA_NODE } from "@/test/nodes";
import { fakeCoordinatorEnv } from "@/test/coordinator";

vi.mock("@/modules/meetings/server/runtime/client.server", async (original) => ({
  ...(await original<object>()),
  callCoordinator: (await import("@/test/coordinator")).recordCoordinatorRequest,
}));

let db: TestDb;
const getAppDb = () => db;

beforeEach(async () => {
  db = await createTestDb();
});

function revokes(requests: ReturnType<typeof fakeCoordinatorEnv>["requests"]) {
  return requests.flatMap((request) =>
    request.kind === "command" && request.command.kind === "revoke"
      ? [{ meetingId: request.meetingId, userId: request.command.userId, reason: request.command.reason }]
      : [],
  );
}

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

async function insertParticipant(id: string, userId: string, status: "connected" | "approved-only") {
  const now = new Date();
  await db.insert(meetingAdmissions).values({
    id: `adm_${id}`,
    meetingId: "mtg_1",
    subjectType: "user",
    subjectUserId: userId,
    guestSecretHash: null,
    displayName: userId,
    admissionStatus: "approved",
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  if (status === "connected") {
    await db.insert(meetingConnections).values({
      id: `conn_${id}`,
      meetingId: "mtg_1",
      admissionId: `adm_${id}`,
      livekitIdentity: `${userId}_identity`,
      livekitParticipantSid: `sid_${id}`,
      userId,
      role: "attendee",
      connectionStatus: "live",
      reason: null,
      tokenIssuedAt: now,
      connectedAt: now,
      disconnectedAt: null,
      lastWebhookAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function seed() {
  const now = new Date();
  await insertUser("owner");
  await insertUser("member");
  await insertUser("other");
  await db.insert(spaces).values({
    kind: "shared",
    id: "spc_1",
    slug: "spc_1-slug",
    name: "Test Space",
    description: null,
    ownerUserId: "owner",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(spaceMembers).values([
    { id: "m_owner", spaceId: "spc_1", userId: "owner", role: "admin", joinedAt: now },
    { id: "m_member", spaceId: "spc_1", userId: "member", role: "member", joinedAt: now },
    { id: "m_other", spaceId: "spc_1", userId: "other", role: "member", joinedAt: now },
  ]);
  await db.insert(meetingLinks).values({
    id: "link_1",
    code: "abc-defg-hij",
    spaceId: "spc_1",
spaceKind: "shared" as const,
    title: "Meeting",
    allowGuests: false,
    joinPolicy: "open",
    createdAt: now,
    updatedAt: now,
    reusePolicy: "reusable",
  });
  await db.insert(meetings).values({
    id: "mtg_1",
    meetingLinkId: "link_1",
    startedByUserId: "owner",
    spaceId: "spc_1",
    spaceKind: "shared" as const,
    title: "Meeting",
    status: "open",
    mediaNodeId: TEST_MEDIA_NODE.id,
    billingPrincipalType: "user" as const,
    billingPrincipalId: "owner",
    billingPlan: "free",
    allowGuests: false,
    recordingEnabled: false,
    joinPolicy: "open",
    startedAt: now,
    endedAt: null,
    updatedAt: now,
  });
  await insertParticipant("member", "member", "connected");
  await insertParticipant("other", "other", "connected");
}

// An Organization space has no owner row; its direct admins are the only managers.
async function seedOrgSpace() {
  const now = new Date();
  await insertUser("admin_a");
  await insertUser("admin_b");
  await db.insert(organizations).values({
    id: "org_1",
    name: "Org",
    ownerId: "admin_a",
    plan: "organization",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(spaces).values({
    kind: "shared",
    id: "spc_org",
    slug: "spc_org-slug",
    name: "Org Space",
    description: null,
    ownerUserId: null,
    organizationId: "org_1",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(spaceMembers).values([
    { id: "om_a", spaceId: "spc_org", userId: "admin_a", role: "admin", joinedAt: now },
    { id: "om_b", spaceId: "spc_org", userId: "admin_b", role: "admin", joinedAt: now },
  ]);
}

describe("evictUserFromSpaceMeetings", () => {
  it("removes the membership and has each open meeting of the space revoke the member", async () => {
    await seed();
    const { env, requests } = fakeCoordinatorEnv();

    expect(await evictUserFromSpaceMeetings(getAppDb(), env, "spc_1", "member")).toBe(true);

    await expect(db.query.spaceMembers.findFirst({ where: { userId: "member" } })).resolves.toBeUndefined();
    expect(revokes(requests)).toEqual([
      { meetingId: "mtg_1", userId: "member", reason: "space_membership_removed" },
    ]);
  });

  it("reaches a meeting that opened immediately before the write", async () => {
    await seed();
    await db.delete(meetings).where(eq(meetings.id, "mtg_1"));
    const { env, requests } = fakeCoordinatorEnv();

    const appDb = getAppDb();
    const originalBatch = appDb.batch.bind(appDb);
    let injected = false;
    appDb.batch = (async (queries: Parameters<Database["batch"]>[0]) => {
      if (!injected) {
        injected = true;
        const now = new Date();
        await db.insert(meetings).values({
          id: "mtg_racing",
          meetingLinkId: "link_1",
          startedByUserId: "owner",
          spaceId: "spc_1",
          spaceKind: "shared",
          title: "Racing Meeting",
          status: "open",
          mediaNodeId: TEST_MEDIA_NODE.id,
          billingPrincipalType: "user",
          billingPrincipalId: "owner",
          billingPlan: "free",
          allowGuests: false,
          recordingEnabled: false,
          joinPolicy: "open",
          startedAt: now,
          updatedAt: now,
        });
        await db.insert(meetingAdmissions).values({
          id: "adm_racing",
          meetingId: "mtg_racing",
          subjectType: "user",
          subjectUserId: "member",
          displayName: "member",
          admissionStatus: "approved",
          decidedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      return originalBatch(queries);
    }) as unknown as Database["batch"];

    await expect(evictUserFromSpaceMeetings(appDb, env, "spc_1", "member")).resolves.toBe(true);
    expect(revokes(requests)).toEqual([
      { meetingId: "mtg_racing", userId: "member", reason: "space_membership_removed" },
    ]);
  });

  it("refuses to remove the last admin of an organization space, but allows it while others remain", async () => {
    await seedOrgSpace();

    // Two admins present: removing one is allowed.
    expect(await evictUserFromSpaceMeetings(getAppDb(), fakeCoordinatorEnv().env, "spc_org", "admin_b")).toBe(true);
    await expect(
      db.query.spaceMembers.findFirst({ where: { userId: "admin_b" } }),
    ).resolves.toBeUndefined();

    // admin_a is now the sole manager: removal is refused and membership retained,
    // so the space can't be stranded with members but nobody who can invite/promote.
    expect(await evictUserFromSpaceMeetings(getAppDb(), fakeCoordinatorEnv().env, "spc_org", "admin_a")).toBe(false);
    await expect(
      db.query.spaceMembers.findFirst({ where: { userId: "admin_a" } }),
    ).resolves.toMatchObject({ role: "admin" });
  });

  it("does not count an admin whose account is being deleted as one who remains", async () => {
    await seedOrgSpace();
    // admin_a entered account deletion while admin_b was still an admin; their
    // membership row stays until the deletion cascades it away.
    await db.update(users).set({ deletionStartedAt: new Date() }).where(eq(users.id, "admin_a"));

    expect(await evictUserFromSpaceMeetings(getAppDb(), fakeCoordinatorEnv().env, "spc_org", "admin_b")).toBe(false);
    await expect(
      db.query.spaceMembers.findFirst({ where: { userId: "admin_b" } }),
    ).resolves.toMatchObject({ role: "admin" });
  });

  it("still lets a personal-space member be removed even though it has no other admins", async () => {
    await seed(); // personal space: one owner, two plain members
    expect(await evictUserFromSpaceMeetings(getAppDb(), fakeCoordinatorEnv().env, "spc_1", "member")).toBe(true);
    await expect(
      db.query.spaceMembers.findFirst({ where: { userId: "member" } }),
    ).resolves.toBeUndefined();
  });
});

describe("refreshSpaceAuthorityInOpenMeetings", () => {
  function authorities(requests: ReturnType<typeof fakeCoordinatorEnv>["requests"]) {
    return requests.flatMap((request) =>
      request.kind === "command" && request.command.kind === "refreshAuthority"
        ? [{ meetingId: request.meetingId, userId: request.command.userId }]
        : [],
    );
  }

  it("asks each open meeting the member is admitted to to re-read their Space role", async () => {
    await seed();
    await db.update(spaceMembers).set({ role: "admin" }).where(eq(spaceMembers.id, "m_member"));
    const { env, requests } = fakeCoordinatorEnv();

    await refreshSpaceAuthorityInOpenMeetings(getAppDb(), env, "member", "spc_1", "space_role_changed");
    expect(authorities(requests)).toEqual([{ meetingId: "mtg_1", userId: "member" }]);
  });

  it("tells no meeting about someone it never admitted", async () => {
    await seed();
    const { env, requests } = fakeCoordinatorEnv();
    await refreshSpaceAuthorityInOpenMeetings(getAppDb(), env, "owner", "spc_1", "space_role_changed");
    expect(requests).toEqual([]);
  });
});

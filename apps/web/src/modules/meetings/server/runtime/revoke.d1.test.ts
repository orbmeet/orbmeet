import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  meetingAdmissions,
  meetingConnections,
  meetingLinks,
  meetings,
  users,
} from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";

import { revokeFromOpenMeetings } from "./revoke.server";
import { TEST_MEDIA_NODE } from "@/test/nodes";
import { fakeCoordinatorEnv } from "@/test/coordinator";

vi.mock("@/modules/meetings/server/runtime/client.server", async (original) => ({
  ...(await original<object>()),
  callCoordinator: (await import("@/test/coordinator")).recordCoordinatorRequest,
}));

let db: TestDb;
const now = new Date("2026-08-23T08:00:00.000Z");

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(users).values([
    {
      id: "host",
      name: "Host",
      email: "host@example.com",
      normalizedEmail: "host@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "peer",
      name: "Peer",
      email: "peer@example.com",
      normalizedEmail: "peer@example.com",
      plan: "free",
      role: "user",
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await seedPersonalSpace(db, "host");
  await db.insert(meetingLinks).values({
    id: "link",
    code: "abc-defg-hij",
    spaceId: "host_space",
    spaceKind: "personal",
    title: "Meeting",
    allowGuests: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: "meeting",
    meetingLinkId: "link",
    spaceId: "host_space",
    spaceKind: "personal",
    startedByUserId: "host",
    title: "Meeting",
    status: "open",
    mediaNodeId: TEST_MEDIA_NODE.id,
    billingPrincipalType: "user",
    billingPrincipalId: "host",
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: false,
    startedAt: now,
    updatedAt: now,
  });
  await db.insert(meetingAdmissions).values({
    id: "admission",
    meetingId: "meeting",
    subjectType: "user",
    subjectUserId: "peer",
    displayName: "Peer",
    admissionStatus: "approved",
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetingConnections).values({
    id: "connection",
    meetingId: "meeting",
    admissionId: "admission",
    livekitIdentity: "peer-identity",
    userId: "peer",
    role: "attendee",
    connectionStatus: "live",
    tokenIssuedAt: now,
    connectedAt: now,
    createdAt: now,
    updatedAt: now,
  });
});

describe("revokeFromOpenMeetings", () => {
  it("has every open meeting where the user holds an admission revoke them", async () => {
    const { env, requests } = fakeCoordinatorEnv();
    await revokeFromOpenMeetings(db, env, "peer", "account_deleted");

    expect(requests).toEqual([
      {
        kind: "command",
        meetingId: "meeting",
        command: { kind: "revoke", userId: "peer", reason: "account_deleted" },
      },
    ]);
  });

  it("leaves ended meetings alone", async () => {
    await db.update(meetings).set({ status: "ended", endedAt: now, updatedAt: now }).where(eq(meetings.id, "meeting"));
    const { env, requests } = fakeCoordinatorEnv();
    await revokeFromOpenMeetings(db, env, "peer", "account_deleted");
    expect(requests).toEqual([]);
  });
});

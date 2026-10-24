import { beforeEach, describe, expect, it } from "vitest";
import { spaceMembers, spaces, users, whiteboards } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import { createWhiteboardJWT } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import { TEST_JWT_KEYRING, TEST_WHITEBOARD_ENV } from "@/test/fake-sync-server";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { verifyActiveWhiteboardBearer } from "./active-whiteboard-auth";

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date();
  await db.insert(users).values({
    id: "owner",
    name: "Owner",
    email: "owner@example.com",
    normalizedEmail: "owner@example.com",
    plan: "free",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(spaces).values({
    id: "space_1",
    slug: null,
    name: "Space",
    kind: "personal",
    ownerUserId: "owner",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(spaceMembers).values({
    id: "member_owner",
    spaceId: "space_1",
    userId: "owner",
    role: "admin",
    joinedAt: now,
  });
  await db.insert(whiteboards).values({
    id: "whiteboard_1",
    syncRoomId: "whiteboard_1",
    spaceId: "space_1",
    title: "Board",
    status: "active",
    createdByUserId: "owner",
    createdAt: now,
    updatedAt: now,
  });
});

describe("verifyActiveWhiteboardBearer solo access", () => {
  it("authorizes a current Space editor without requiring a Meeting", async () => {
    const token = await createWhiteboardJWT(TEST_JWT_KEYRING, {
      sub: "owner",
      name: "Owner",
      role: "participant",
      capabilities: {
        canEditWhiteboard: true,
        canControlSurface: false,
        canManageWhiteboard: false,
      },
      sid: toWhiteboardRoomId("whiteboard_1"),
      connectionId: "solo",
      grantPrincipal: { type: "user", id: "owner" },
      service: "solo",
      documentId: "whiteboard_1",
    });

    const result = await verifyActiveWhiteboardBearer(
      new Request("https://app.example/api", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { ...TEST_WHITEBOARD_ENV } as Env,
      db,
    );

    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({
      meetingId: null,
      syncRoomId: "whiteboard_1",
      access: {
        userId: "owner",
        participantIdentity: "owner",
        canEditWhiteboard: true,
      },
    });
  });
});

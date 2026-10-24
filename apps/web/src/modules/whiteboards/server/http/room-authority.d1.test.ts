import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { spaceMembers, spaces, users, whiteboards } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import {
  parseKeyring,
  SIGNATURE_HEADER,
  signatureTarget,
  signRequest,
} from "@orbmeet/primitives";
import {
  ROOM_AUTHORITY_PATH,
  type AuthorityClaim,
} from "@orbmeet/whiteboard-core/sync-commands";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { createTestDb, type TestDb } from "@/test/db";
import { TEST_CALLBACK_KEYS, TEST_COMMAND_KEYS, TEST_WHITEBOARD_ENV } from "@/test/fake-sync-server";
import { handleRoomAuthority } from "./room-authority";

const AUTHORITY_URL = `https://app.example${ROOM_AUTHORITY_PATH}`;
const workerEnv = { ...env, ...TEST_WHITEBOARD_ENV } as unknown as Env;

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date();
  await db.insert(users).values(
    ["owner", "outsider"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
      normalizedEmail: `${id}@example.com`,
      plan: "free" as const,
      role: "user" as const,
      createdAt: now,
      updatedAt: now,
    })),
  );
  await db.insert(spaces).values({
    id: "space_1",
    slug: "space-1",
    name: "Space",
    kind: "shared",
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
    syncNodeId: "test-node",
    spaceId: "space_1",
    title: "Board",
    createdByUserId: "owner",
    createdAt: now,
    updatedAt: now,
  });
});

function soloClaim(userId: string): AuthorityClaim {
  return {
    sub: userId,
    role: "participant",
    connectionId: "solo",
    grantPrincipalKey: `user:${userId}`,
    capabilities: {
      canEditWhiteboard: true,
      canControlSurface: false,
      canManageWhiteboard: false,
    },
    service: "solo",
    documentId: "whiteboard_1",
  };
}

async function authorityRequest(
  body: unknown,
  keys: string = TEST_CALLBACK_KEYS,
): Promise<Request> {
  const text = JSON.stringify(body);
  return new Request(AUTHORITY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SIGNATURE_HEADER]: await signRequest({
        method: "POST",
        target: signatureTarget(AUTHORITY_URL),
        body: text,
        keyring: parseKeyring(keys)!,
      }),
    },
    body: text,
  });
}

describe("handleRoomAuthority", () => {
  it("answers one verdict per claim, in request order", async () => {
    const response = await handleRoomAuthority(
      await authorityRequest({
        whiteboardRoomId: toWhiteboardRoomId("whiteboard_1"),
        claims: [soloClaim("outsider"), soloClaim("owner")],
      }),
      workerEnv,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ verdicts: ["denied", "active"] });
  });

  it("refreshes every claim of a room the board has moved on from, and judges the current one", async () => {
    await db.update(whiteboards).set({ syncGeneration: 2 }).where(eq(whiteboards.id, "whiteboard_1"));
    const ask = async (generation: number) => (await handleRoomAuthority(
      await authorityRequest({
        whiteboardRoomId: toWhiteboardRoomId("whiteboard_1"),
        generation,
        claims: [soloClaim("outsider"), soloClaim("owner")],
      }),
      workerEnv,
    )).json();

    await expect(ask(1)).resolves.toEqual({ verdicts: ["refresh", "refresh"] });
    await expect(ask(2)).resolves.toEqual({ verdicts: ["denied", "active"] });
  });

  it("tells a node the board is not on only to refresh: a node learns nothing of boards it does not hold", async () => {
    await db.update(whiteboards).set({ syncNodeId: "ams1" }).where(eq(whiteboards.id, "whiteboard_1"));
    const response = await handleRoomAuthority(
      await authorityRequest({
        whiteboardRoomId: toWhiteboardRoomId("whiteboard_1"),
        claims: [soloClaim("outsider"), soloClaim("owner")],
      }),
      workerEnv,
    );
    await expect(response.json()).resolves.toEqual({ verdicts: ["refresh", "refresh"] });
  });

  it("denies a claim once D1 no longer backs it", async () => {
    await db.update(whiteboards)
      .set({ status: "archived", archivedAt: new Date() })
      .where(eq(whiteboards.id, "whiteboard_1"));

    const response = await handleRoomAuthority(
      await authorityRequest({
        whiteboardRoomId: toWhiteboardRoomId("whiteboard_1"),
        claims: [soloClaim("owner")],
      }),
      workerEnv,
    );

    await expect(response.json()).resolves.toEqual({ verdicts: ["denied"] });
  });

  it("refuses a request not signed with the callback keyring", async () => {
    const body = { whiteboardRoomId: toWhiteboardRoomId("whiteboard_1"), claims: [soloClaim("owner")] };

    // The command keyring is the other direction's: it must not verify here.
    const wrongKey = await handleRoomAuthority(await authorityRequest(body, TEST_COMMAND_KEYS), workerEnv);
    expect(wrongKey.status).toBe(401);

    const unsigned = await handleRoomAuthority(
      new Request(AUTHORITY_URL, { method: "POST", body: JSON.stringify(body) }),
      workerEnv,
    );
    expect(unsigned.status).toBe(401);

    const unconfigured = await handleRoomAuthority(
      await authorityRequest(body),
      { ...workerEnv, NODES: "" },
    );
    expect(unconfigured.status).toBe(503);
  });

  it("rejects a malformed claim list", async () => {
    const response = await handleRoomAuthority(
      await authorityRequest({
        whiteboardRoomId: toWhiteboardRoomId("whiteboard_1"),
        claims: [{ ...soloClaim("owner"), role: "host" }],
      }),
      workerEnv,
    );
    expect(response.status).toBe(400);
  });
});

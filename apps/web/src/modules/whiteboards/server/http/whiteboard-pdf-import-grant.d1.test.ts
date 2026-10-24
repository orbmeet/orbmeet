import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  files,
  spaceMembers,
  spaces,
  uploadReservations,
  users,
  whiteboardFileReferences,
  whiteboards,
} from "@orbmeet/db/schema";
import { parseKeyring, SIGNATURE_HEADER, signatureTarget, signRequest } from "@orbmeet/primitives";
import { buildWhiteboardPdfImportAssetKey } from "@orbmeet/whiteboard-core/whiteboard-asset-key";
import { createTestDb, type TestDb } from "@/test/db";
import { TEST_CALLBACK_KEYS, TEST_WHITEBOARD_ENV } from "@/test/fake-sync-server";
import {
  handlePdfImportGrant,
  recordStoredPdfSource,
  resolvePdfImportParticipantAccess,
  resolveStoredPdfSourceForMember,
} from "./whiteboard-pdf-import-grant";

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
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
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

describe("resolveStoredPdfSource", () => {
  async function insertFile() {
    await db.insert(files).values({
      id: "file_1",
      spaceId: "space_1",
      type: "pdf",
      status: "committed",
      r2Key: "spaces/space_1/uploads/file_1.pdf",
      filename: "source.pdf",
      mimeType: "application/pdf",
      size: 7_327_927,
      uploadedByUserId: "owner",
    });
  }

  it("resolves a committed Space PDF without creating a preflight reference", async () => {
    await insertFile();

    await expect(resolveStoredPdfSourceForMember(db, {
      spaceId: "space_1",
      userId: "owner",
      fileId: "file_1",
    })).resolves.toEqual({
      r2Key: "spaces/space_1/uploads/file_1.pdf",
      size: 7_327_927,
    });
    await expect(db.select().from(whiteboardFileReferences)).resolves.toEqual([]);
  });

  it("records the source only when finalization requests it", async () => {
    await insertFile();

    await recordStoredPdfSource(db, {
      whiteboardId: "whiteboard_1",
      spaceId: "space_1",
      fileId: "file_1",
    });

    await expect(db.select().from(whiteboardFileReferences)).resolves.toHaveLength(1);
  });

  it("does not reference an unknown file", async () => {
    await expect(resolveStoredPdfSourceForMember(db, {
      spaceId: "space_1",
      userId: "owner",
      fileId: "missing",
    })).resolves.toBeNull();
    await expect(db.select().from(whiteboardFileReferences)).resolves.toEqual([]);
  });

  it("does not resolve a stored PDF for a guest editor", async () => {
    await expect(resolveStoredPdfSourceForMember(db, {
      spaceId: "space_1",
      userId: null,
      fileId: "file_1",
    })).resolves.toBeNull();
  });
});

describe("resolvePdfImportParticipantAccess", () => {
  it("authorizes a solo Space editor without a Meeting connection", async () => {
    await expect(resolvePdfImportParticipantAccess(db, {
      whiteboardId: "whiteboard_1",
      syncRoomId: "whiteboard_1",
      connectionId: "solo",
      participantIdentity: "owner",
    })).resolves.toEqual({
      userId: "owner",
      admissionId: null,
      participantIdentity: "owner",
      canEditWhiteboard: true,
    });
  });

  it("does not let a solo identity cross into another document", async () => {
    await expect(resolvePdfImportParticipantAccess(db, {
      whiteboardId: "whiteboard_other",
      syncRoomId: "whiteboard_1",
      connectionId: "solo",
      participantIdentity: "owner",
    })).resolves.toBeNull();
  });
});

describe("handlePdfImportGrant", () => {
  const GRANT_URL = "https://app.example/api/whiteboard/pdf-import-grant";
  const workerEnv = { ...env, ...TEST_WHITEBOARD_ENV } as unknown as Env;
  const importId = "cae07632-4d82-4de0-848f-501bd7586496";
  const page = (n: number) => buildWhiteboardPdfImportAssetKey("whiteboard_1", importId, n);

  async function grant(body: Record<string, unknown>, participantIdentity = "owner") {
    const text = JSON.stringify({
      meetingId: "meet-whiteboard_1",
      connectionId: "solo",
      participantIdentity,
      importId,
      ...body,
    });
    return handlePdfImportGrant(new Request(GRANT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: await signRequest({
          method: "POST",
          target: signatureTarget(GRANT_URL),
          body: text,
          keyring: parseKeyring(TEST_CALLBACK_KEYS)!,
        }),
      },
      body: text,
    }), workerEnv);
  }

  const statuses = async () => Object.fromEntries(
    (await db.query.whiteboardAssets.findMany({ where: { whiteboardId: "whiteboard_1" } }))
      .map((row) => [row.r2Key, row.status]),
  );

  it("reserves, registers each batch as committed, and retires what the board never showed", async () => {
    const preflight = await grant({ phase: "preflight", reserveBytes: 4096 });
    expect(preflight.status).toBe(200);
    await expect(preflight.json()).resolves.toEqual({
      uploadPrefix: `whiteboards/whiteboard_1/assets/imports/${importId}/`,
    });

    expect((await grant({ phase: "commit", pages: [{ r2Key: page(1), size: 100 }] })).status).toBe(200);
    expect((await grant({ phase: "commit", pages: [{ r2Key: page(2), size: 200 }] })).status).toBe(200);
    expect(await statuses()).toEqual({ [page(1)]: "committed", [page(2)]: "committed" });

    expect((await grant({ phase: "release", placedKeys: [page(1)] })).status).toBe(200);
    expect(await statuses()).toEqual({ [page(1)]: "committed", [page(2)]: "deleting" });
    await expect(db.select().from(uploadReservations)).resolves.toEqual([]);
  });

  it("refuses a page key outside this import", async () => {
    await grant({ phase: "preflight", reserveBytes: 4096 });
    const foreign = "whiteboards/whiteboard_1/assets/imports/11111111-2222-4333-8444-555555555555/page-1.png";
    expect((await grant({ phase: "commit", pages: [{ r2Key: foreign, size: 100 }] })).status).toBe(400);
    expect((await grant({ phase: "release", placedKeys: [foreign] })).status).toBe(400);
    expect(await statuses()).toEqual({});
  });

  it("refuses to register pages for someone without edit access", async () => {
    const response = await grant({ phase: "commit", pages: [{ r2Key: page(1), size: 100 }] }, "outsider");
    expect(response.status).toBe(403);
    expect(await statuses()).toEqual({});
  });

  it("lets only the node holding the board add to it, while any node may give back", async () => {
    await grant({ phase: "preflight", reserveBytes: 4096 });
    await db.update(whiteboards).set({ syncNodeId: "ams1" }).where(eq(whiteboards.id, "whiteboard_1"));

    expect((await grant({ phase: "commit", pages: [{ r2Key: page(1), size: 100 }] })).status).toBe(403);
    expect(await statuses()).toEqual({});
    // The board moved while the import ran: its old node still releases what it reserved.
    expect((await grant({ phase: "release", placedKeys: [] })).status).toBe(200);
  });

  it("releases an import whose participant has since left", async () => {
    await grant({ phase: "preflight", reserveBytes: 4096 });
    await grant({ phase: "commit", pages: [{ r2Key: page(1), size: 100 }] });

    // Release only gives back, so it needs no live participant.
    expect((await grant({ phase: "release", placedKeys: [] }, "outsider")).status).toBe(200);
    expect(await statuses()).toEqual({ [page(1)]: "deleting" });
    await expect(db.select().from(uploadReservations)).resolves.toEqual([]);
  });
});

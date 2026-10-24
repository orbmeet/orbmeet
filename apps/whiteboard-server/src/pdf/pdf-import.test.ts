import { TEST_CALLBACK_KEYRING } from "../http/test-keyrings.ts";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { installMutoolDouble, installPdfImportFetchStub } from "../../test/pdf-doubles.ts";
import { incomingRequest } from "../../test/requests.ts";
import { Reply } from "../http/reply.ts";
import {
  type ImportRoom,
  handlePdfImportCancel,
  handlePdfImportStart,
  handlePdfImportStatus,
} from "./pdf-import.ts";
import { capacity, initializePdfRenderScratchDir } from "./pdf-import-jobs.ts";

vi.mock("./mutool.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./mutool.ts")>(),
  ...(await import("../../test/pdf-doubles.ts")).mutoolModule,
}));

const TMP_DIR = mkdtempSync(join(tmpdir(), "orbmeet-pdf-import-"));
const UPLOAD_PREFIX = (importId: string) => `whiteboards/wb-test/assets/imports/${importId}/`;
const R2_CONFIG = { accessKeyId: "ak", secretAccessKey: "sk", accountId: "acct", bucketName: "bucket" };

function grantFor(userId: string) {
  return {
    meetingSid: "meet-pdf-import",
    connectionId: "conn-1",
    participantIdentity: userId,
    appUrl: "https://app.test",
    callbackKeyring: TEST_CALLBACK_KEYRING,
  };
}

type InsertSpec = Parameters<ImportRoom["insertImportedPages"]>[1];

/** A room that places whatever it is given, unless told otherwise. */
function fakeRoom(options: {
  canAdd?: () => boolean;
  insert?: (spec: InsertSpec) => ReturnType<ImportRoom["insertImportedPages"]>;
} = {}) {
  const inserts: InsertSpec[] = [];
  const room: ImportRoom = {
    canUserAddPages: () => options.canAdd?.() ?? true,
    insertImportedPages: (_userId, spec) => {
      inserts.push(spec);
      return options.insert?.(spec) ?? {
        reply: Reply.json({ status: "pages_imported" }),
        placedPageIndices: spec.pages.map((page) => page.pageIndex),
      };
    },
  };
  return { room, inserts };
}

function uploadRequest(query: string): IncomingMessage {
  const body = Buffer.from("%PDF-1.7 test");
  return incomingRequest({
    method: "POST",
    url: `/pdf-import?${query}`,
    headers: { "Content-Type": "application/pdf", "Content-Length": String(body.byteLength) },
    body,
  });
}

let userCount = 0;
/** A participant of their own: the per-user rate limits outlast one test. */
let currentUser = "user-0";

async function start(request: IncomingMessage, room: ImportRoom, userId = currentUser) {
  const reply = await handlePdfImportStart(request, new URL(request.url!, "http://localhost"), grantFor(userId), {
    r2Config: R2_CONFIG,
    findRoom: () => room,
  });
  return { reply, body: reply.json as { id: string; pageCount: number; error?: string } };
}

/** Wait until `condition` holds; this repo's waitFor retries only on a throw. */
function until(condition: () => boolean) {
  return vi.waitFor(() => {
    if (!condition()) throw new Error("not yet");
  });
}

async function finished(id: string, userId = currentUser) {
  return vi.waitFor(async () => {
    const status = handlePdfImportStatus(id, grantFor(userId)).json as {
      state: string;
      placedCount: number;
      pageCount: number;
      error?: string;
    };
    if (status.state === "importing") throw new Error("still importing");
    return status;
  });
}

beforeAll(async () => {
  await initializePdfRenderScratchDir(TMP_DIR);
});

beforeEach(() => {
  currentUser = `user-${++userCount}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("PDF import", () => {
  it("registers each page before the room shows it, then releases with the placed pages", async () => {
    installMutoolDouble({ pageCount: 5 });
    const stub = installPdfImportFetchStub({ uploadPrefix: UPLOAD_PREFIX });
    const { room, inserts } = fakeRoom();

    const { reply, body } = await start(uploadRequest("insertIndex=1"), room);
    expect(reply.status).toBe(200);
    expect(body.pageCount).toBe(5);
    expect(await finished(body.id)).toEqual({ state: "done", pageCount: 5, placedCount: 5 });

    const keys = [1, 2, 3, 4, 5].map((page) => `${UPLOAD_PREFIX(body.id)}page-${page}.png`);
    expect([...stub.uploadedKeys].sort()).toEqual(keys);
    const committed = stub.grants.filter((grant) => grant.phase === "commit")
      .flatMap((grant) => (grant.pages as Array<{ r2Key: string }>).map((page) => page.r2Key));
    expect(committed.sort()).toEqual(keys);
    expect(inserts.flatMap((spec) => spec.pages.map((page) => page.r2Key)).sort()).toEqual(keys);
    expect(stub.grants.at(-1)).toMatchObject({ phase: "release", placedKeys: expect.arrayContaining(keys) });

    // The import leaves nothing behind on this node.
    expect(readdirSync(TMP_DIR)).toEqual([]);
    expect(capacity.activeImports).toBe(0);
    expect(capacity.reservedScratchBytes).toBe(0);
  });

  it("positions only the first batch, and follows its own last page after that", async () => {
    // The last of three shards fails, but is held open: the first two land as
    // separate batches before it settles.
    const mutool = installMutoolDouble({ pageCount: 8, failDrawShardFromPage: 7 });
    installPdfImportFetchStub({ uploadPrefix: UPLOAD_PREFIX });
    const { room, inserts } = fakeRoom();

    const { body } = await start(uploadRequest("insertIndex=0&reuseFrameId=shape:page-1"), room);
    await until(() => inserts.flatMap((spec) => spec.pages).length === 6);
    mutool.releaseFailingShard();
    const status = await finished(body.id);

    expect(status).toMatchObject({ state: "failed", placedCount: 6, error: "Failed to render PDF" });
    expect(inserts[0]).toMatchObject({ insertIndex: 0, reuse: { frameId: "shape:page-1" } });
    expect(inserts[0].after).toBeUndefined();
    for (const spec of inserts.slice(1)) {
      expect(spec.reuse).toBeUndefined();
      expect(spec.after).toBeDefined();
    }
  });

  it("keeps the pages a late render failure left on the board", async () => {
    const mutool = installMutoolDouble({ pageCount: 8, failDrawShardFromPage: 7 });
    const stub = installPdfImportFetchStub({ uploadPrefix: UPLOAD_PREFIX });
    const { room, inserts } = fakeRoom();

    const { body } = await start(uploadRequest("insertIndex=0"), room);
    await until(() => inserts.flatMap((spec) => spec.pages).length === 6);
    mutool.releaseFailingShard();
    await finished(body.id);

    const release = stub.grants.at(-1)!;
    expect(release.phase).toBe("release");
    expect((release.placedKeys as string[]).length).toBe(6);
  });

  it("deletes a batch the app refuses to register, and shows none of it", async () => {
    installMutoolDouble({ pageCount: 2 });
    const stub = installPdfImportFetchStub({ uploadPrefix: UPLOAD_PREFIX, refuseCommit: true });
    const { room, inserts } = fakeRoom();

    const { body } = await start(uploadRequest("insertIndex=0"), room);
    expect(await finished(body.id)).toMatchObject({ state: "failed", placedCount: 0, error: "Storage quota exceeded" });
    expect(inserts).toEqual([]);
    expect(stub.deletedKeys.sort()).toEqual([...stub.uploadedKeys].sort());
    expect(stub.grants.at(-1)).toMatchObject({ phase: "release", placedKeys: [] });
  });

  it("records what the room placed when it applies only part of a batch", async () => {
    installMutoolDouble({ pageCount: 3 });
    const stub = installPdfImportFetchStub({ uploadPrefix: UPLOAD_PREFIX });
    const { room } = fakeRoom({
      insert: (spec) => ({
        reply: Reply.json({ error: "Only part of this import is on the whiteboard" }, 409),
        placedPageIndices: [spec.pages[0].pageIndex],
      }),
    });

    const { body } = await start(uploadRequest("insertIndex=0"), room);
    expect(await finished(body.id)).toMatchObject({
      state: "failed",
      placedCount: 1,
      error: "Only part of this import is on the whiteboard",
    });
    expect(stub.grants.at(-1)).toMatchObject({ placedKeys: [`${UPLOAD_PREFIX(body.id)}page-1.png`] });
  });

  it("stops placing pages once the importer loses edit access", async () => {
    installMutoolDouble({ pageCount: 2 });
    installPdfImportFetchStub({ uploadPrefix: UPLOAD_PREFIX });
    // The router let the import start; access is gone by the first batch.
    const { room, inserts } = fakeRoom({ canAdd: () => false });

    const { body } = await start(uploadRequest("insertIndex=0"), room);
    expect(await finished(body.id)).toMatchObject({ state: "failed", error: "Whiteboard edit access is required" });
    expect(inserts).toEqual([]);
  });

  it("caps the import at the pages the board can take", async () => {
    installMutoolDouble({ pageCount: 5 });
    installPdfImportFetchStub({ uploadPrefix: UPLOAD_PREFIX });
    const { room, inserts } = fakeRoom();

    const { body } = await start(uploadRequest("insertIndex=0&maxPages=2"), room);
    expect(body.pageCount).toBe(2);
    expect(await finished(body.id)).toMatchObject({ state: "done", placedCount: 2 });
    expect(inserts.flatMap((spec) => spec.pages.map((page) => page.pageIndex))).toEqual([0, 1]);
  });

  it("renders a stored Space file and stamps each page with where it came from", async () => {
    installMutoolDouble({ pageCount: 2 });
    const source = { fileId: "file_1", r2Key: "spaces/s/files/file_1.pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.7 src")) };
    const stub = installPdfImportFetchStub({ uploadPrefix: UPLOAD_PREFIX, sourcePdf: source });
    const { room, inserts } = fakeRoom();

    const { body } = await start(incomingRequest({
      method: "POST",
      url: "/pdf-import?insertIndex=0",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceFileId: "file_1" }),
    }), room);
    expect(await finished(body.id)).toMatchObject({ state: "done", placedCount: 2 });

    expect(stub.downloadedKeys).toEqual([source.r2Key]);
    expect(inserts.flatMap((spec) => spec.pages).map(({ sourceFileId, sourcePageNumber }) => ({ sourceFileId, sourcePageNumber })))
      .toEqual([{ sourceFileId: "file_1", sourcePageNumber: 1 }, { sourceFileId: "file_1", sourcePageNumber: 2 }]);
    expect(stub.grants.at(-1)).toMatchObject({ phase: "release", sourceFileId: "file_1" });
  });

  it("stops before placing anything when cancelled mid-render", async () => {
    const mutool = installMutoolDouble({ pageCount: 3, blockRender: true });
    installPdfImportFetchStub({ uploadPrefix: UPLOAD_PREFIX });
    const { room, inserts } = fakeRoom();

    const { body } = await start(uploadRequest("insertIndex=0"), room);
    expect(handlePdfImportCancel(body.id, currentUser, "meet-pdf-import").status).toBe(204);
    mutool.releaseRender();
    expect(await finished(body.id)).toMatchObject({ state: "failed", placedCount: 0, error: "PDF import was cancelled" });
    expect(inserts).toEqual([]);
  });

  it("shows an import only to the participant who started it", async () => {
    installMutoolDouble({ pageCount: 1 });
    installPdfImportFetchStub({ uploadPrefix: UPLOAD_PREFIX });
    const { room } = fakeRoom();

    const { body } = await start(uploadRequest("insertIndex=0"), room);
    expect(handlePdfImportStatus(body.id, grantFor("someone-else")).status).toBe(403);
    expect(handlePdfImportCancel(body.id, "someone-else", "meet-pdf-import").status).toBe(403);
    await finished(body.id);
  });

  it("refuses a range longer than one import may render", async () => {
    installMutoolDouble({ pageCount: 150 });
    const stub = installPdfImportFetchStub({ uploadPrefix: UPLOAD_PREFIX });
    const { room } = fakeRoom();

    const { reply, body } = await start(uploadRequest("insertIndex=0"), room);
    expect(reply.status).toBe(400);
    expect(body.error).toBe("PDF has 150 pages. Select a range of at most 100 pages.");
    // The quota reserved for it is given back at once.
    expect(stub.grants.map((grant) => grant.phase)).toEqual(["preflight", "release"]);
    expect(capacity.activeImports).toBe(0);
  });
});

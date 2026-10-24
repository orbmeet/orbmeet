import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TLShapeId } from "tldraw";
import type { PageManager } from "../pages/page-manager";
import { importPdfToWhiteboard } from "./import-pdf";
import { PdfImportPartialError } from "./pdf-import-partial-error";

const JOB_ID = "00000000-0000-4000-8000-000000000001";
const START_URL = "https://whiteboard.example/pdf-import";
const STATUS_URL = `https://whiteboard.example/pdf-import/${JOB_ID}`;

function pageManagerStub(existingPages = 0): PageManager {
  return {
    getPages: () =>
      Array.from({ length: existingPages }, (_, index) => ({
        id: `shape:page-${index + 1}` as TLShapeId,
        number: index + 1,
        y: index * 940,
        height: 900,
      })),
  } as unknown as PageManager;
}

/** A whiteboard server whose import reports `statuses` in turn, then the last one forever. */
function serverStub(statuses: Array<{ state: string; placedCount: number; error?: string }>, pageCount = 3) {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  let poll = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body });
    if (url.startsWith(START_URL) && method === "POST" && !url.startsWith(`${START_URL}/`)) {
      return Response.json({ id: JOB_ID, pageCount, sourcePageStart: 1, sourcePageCount: pageCount });
    }
    if (url === STATUS_URL && method === "GET") {
      const status = statuses[Math.min(poll++, statuses.length - 1)];
      return Response.json({ pageCount, ...status });
    }
    if (url === STATUS_URL && method === "DELETE") return new Response(null, { status: 204 });
    return new Response("Unexpected request", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests };
}

const base = {
  whiteboardUrl: "https://whiteboard.example/",
  token: "token",
};

describe("importPdfToWhiteboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts one server-side import and reports its progress until done", async () => {
    const { requests } = serverStub([
      { state: "importing", placedCount: 1 },
      { state: "done", placedCount: 3 },
    ]);
    const progress: Array<[number, number]> = [];

    const result = importPdfToWhiteboard({
      ...base,
      sourceFileId: "asset-deck",
      pageManager: pageManagerStub(2),
      insertPosition: { type: "on", page: 1 },
      onProgress: (current, total) => progress.push([current, total]),
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ pagesImported: 3, pagesFailed: 0 });
    expect(progress).toEqual([[1, 3], [3, 3]]);
    const start = new URL(requests[0].url);
    expect(Object.fromEntries(start.searchParams)).toEqual({
      insertIndex: "1",
      reuseFrameId: "shape:page-1",
      maxPages: expect.any(String),
    });
    expect(JSON.parse(String(requests[0].body))).toEqual({ sourceFileId: "asset-deck" });
  });

  it("reports pages already on the board when the import fails partway", async () => {
    serverStub([{ state: "failed", placedCount: 2, error: "Failed to render PDF" }]);

    const outcome = importPdfToWhiteboard({ ...base, sourceFileId: "asset-deck", pageManager: pageManagerStub() })
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await outcome;
    expect(error).toBeInstanceOf(PdfImportPartialError);
    expect(error).toMatchObject({ pagesImported: 2 });
  });

  it("fails plainly when nothing reached the board", async () => {
    serverStub([{ state: "failed", placedCount: 0, error: "Storage quota exceeded" }]);

    const outcome = importPdfToWhiteboard({ ...base, sourceFileId: "asset-deck", pageManager: pageManagerStub() })
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await outcome;
    expect(error).toMatchObject({ message: "Storage quota exceeded" });
    expect(error).not.toBeInstanceOf(PdfImportPartialError);
  });

  it("cancels the server's import when the caller aborts", async () => {
    const { requests } = serverStub([{ state: "importing", placedCount: 0 }]);
    const controller = new AbortController();

    const outcome = importPdfToWhiteboard({
      ...base,
      sourceFileId: "asset-deck",
      pageManager: pageManagerStub(),
      signal: controller.signal,
    }).then(() => "resolved", () => "rejected");
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    expect(await outcome).toBe("rejected");

    expect(requests.at(-1)).toMatchObject({ url: STATUS_URL, method: "DELETE" });
  });

  it("refuses before uploading anything when the board is full", async () => {
    const { requests } = serverStub([]);
    await expect(importPdfToWhiteboard({
      ...base,
      sourceFileId: "asset-deck",
      pageManager: pageManagerStub(500),
    })).rejects.toThrow("whiteboard page limit reached");
    expect(requests).toEqual([]);
  });
});

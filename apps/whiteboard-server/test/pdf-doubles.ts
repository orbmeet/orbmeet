import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { vi } from "vitest";

import type { MutoolProcess } from "../src/pdf/mutool.ts";

type SpawnMutool = (args: string[]) => MutoolProcess;

let currentMutool: SpawnMutool = () => {
  throw new Error("No mutool double installed; call installMutoolDouble()");
};

/**
 * The double for src/pdf/mutool.ts's `spawnMutool`, for `vi.mock`:
 *
 *     vi.mock("./mutool.ts", async (importOriginal) => ({
 *       ...await importOriginal(),
 *       ...(await import("../../test/pdf-doubles.ts")).mutoolModule,
 *     }));
 */
export const mutoolModule = {
  spawnMutool: (args: string[]) => currentMutool(args),
};

/** A process that prints `stdout`, then exits with what `exit` resolves to. */
function fakeProcess(exit: Promise<number>, stdout?: string): MutoolProcess {
  const proc = Object.assign(new EventEmitter(), {
    stdout: stdout === undefined ? null : Readable.from([Buffer.from(stdout)]),
    stderr: null,
    kill: () => true,
  });
  void exit.then((code) => proc.emit("close", code, null));
  return proc;
}

export interface MutoolDouble {
  /** Let the fake mutool write its pages and exit (only when `blockRender`). */
  releaseRender(): void;
  /** Let the failing shard (see `failDrawShardFromPage`) finally exit. */
  releaseFailingShard(): void;
}

export interface MutoolDoubleOptions {
  /** How many PNG pages the fake mutool produces. */
  pageCount?: number;
  /** Hold the render open until `releaseRender()` is called. */
  blockRender?: boolean;
  /**
   * Fail (exit 1, no files written) any draw shard whose range starts at or
   * after this page — models a late shard failure while earlier shards have
   * already produced committable pages. The failing shard's exit is held until
   * `releaseFailingShard()` so tests can act while the render is incomplete.
   */
  failDrawShardFromPage?: number;
  /**
   * Size of each rendered page file. Small by default; a test that watches a
   * page response mid-stream needs pages read in more than one chunk.
   */
  pageBytes?: number;
}

/** A PNG header (all readPngDimensions inspects), padded to `bytes`. */
function pngPage(width: number, height: number, bytes: number): Buffer {
  const buf = Buffer.alloc(Math.max(64, bytes));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** A scripted mutool: `info` reports `pageCount`; `draw` writes its range's pages. */
export function installMutoolDouble(
  { pageCount = 1, blockRender = false, failDrawShardFromPage, pageBytes = 64 }: MutoolDoubleOptions = {},
): MutoolDouble {
  let release = () => {};
  const gate = blockRender
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : null;
  let releaseFailure = () => {};
  const failureGate = failDrawShardFromPage !== undefined
    ? new Promise<void>((resolve) => {
        releaseFailure = resolve;
      })
    : null;

  currentMutool = (args) => {
    // `mutool info` is the page-count pre-pass the render handler runs before
    // planning shards. Only the "Pages:" line is parsed.
    if (args[0] === "info") {
      return fakeProcess(Promise.resolve(0), `Pages: ${pageCount}\nRetrieving info from pages 1-${pageCount}...\n`);
    }

    // `mutool draw` renders only the pages in its own `first-last` range, so
    // a sharded render writes disjoint subsets across several spawns. Modelling
    // the range (rather than always writing 1..pageCount) is what lets these
    // tests catch a shard plan that gaps or double-covers the document.
    const outputTemplate = args[args.indexOf("-o") + 1];
    const range = args[args.length - 1].match(/^(\d+)-(\d+)$/);
    const first = range ? Number(range[1]) : 1;
    const last = range ? Math.min(Number(range[2]), pageCount) : pageCount;
    const exited = (async () => {
      if (gate) await gate;
      if (failDrawShardFromPage !== undefined && first >= failDrawShardFromPage) {
        await failureGate;
        return 1;
      }
      if (first > pageCount) {
        // Verified against mutool 1.25.6: a range entirely past the end still
        // exits 0 and emits the document's *last* page. A shard plan must
        // therefore never overrun, or the import gains a duplicate page.
        writeFileSync(outputTemplate.replace("%d", String(pageCount)), pngPage(1200, 1600, pageBytes));
        return 0;
      }
      for (let page = first; page <= last; page += 1) {
        writeFileSync(outputTemplate.replace("%d", String(page)), pngPage(1200, 1600, pageBytes));
      }
      return 0;
    })();
    return fakeProcess(exited);
  };

  return {
    releaseRender: () => release(),
    releaseFailingShard: () => releaseFailure(),
  };
}

export interface R2FetchStub {
  /** Object keys the import has PUT, in request order. */
  uploadedKeys: string[];
  /** Object keys the import has deleted. */
  deletedKeys: string[];
  /** Stored source objects fetched for rendering. */
  downloadedKeys: string[];
  /** Every grant call the import made, in order. */
  grants: Array<{ phase: string; [field: string]: unknown }>;
}

/**
 * Stub `fetch` for the PDF import grant callbacks and R2. aws4fetch signs and
 * then calls `fetch(request)` with no init, so both call shapes are handled.
 */
export function installPdfImportFetchStub(
  {
    uploadPrefix,
    sourcePdf,
    refuseCommit = false,
  }: {
    uploadPrefix: (importId: string) => string;
    sourcePdf?: {
      fileId: string;
      r2Key: string;
      bytes: Uint8Array;
      metadataSize?: number;
      responseSize?: number;
    };
    /** Answer every commit grant with a quota refusal. */
    refuseCommit?: boolean;
  },
): R2FetchStub {
  const uploadedKeys: string[] = [];
  const deletedKeys: string[] = [];
  const downloadedKeys: string[] = [];
  const grants: R2FetchStub["grants"] = [];

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const asRequest = input instanceof Request ? input : null;
    const url = asRequest ? asRequest.url : String(input);
    const method = asRequest ? asRequest.method : (init?.method ?? "GET");

    if (url.includes("/api/whiteboard/pdf-import-grant")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        phase: string;
        sourceFileId?: string;
        importId?: string;
      };
      grants.push(body);
      if (body.phase === "preflight") {
        return Response.json({
          uploadPrefix: uploadPrefix(body.importId ?? ""),
          ...(sourcePdf && body.sourceFileId === sourcePdf.fileId
            ? { source: { r2Key: sourcePdf.r2Key, size: sourcePdf.metadataSize ?? sourcePdf.bytes.byteLength } }
            : {}),
        });
      }
      if (body.phase === "commit" && refuseCommit) {
        return new Response("Storage quota exceeded", { status: 403 });
      }
      return Response.json({ ok: true });
    }

    if (method === "GET" && sourcePdf && url.includes(sourcePdf.r2Key)) {
      downloadedKeys.push(sourcePdf.r2Key);
      return new Response(new Uint8Array(sourcePdf.bytes), {
        headers: {
          "Content-Length": String(sourcePdf.responseSize ?? sourcePdf.bytes.byteLength),
        },
      });
    }

    if (url.includes("r2.cloudflarestorage.com") && (method === "PUT" || method === "DELETE")) {
      const key = new URL(url).pathname.split("/").slice(2).join("/");
      (method === "PUT" ? uploadedKeys : deletedKeys).push(key);
      return new Response(null, { status: method === "PUT" ? 200 : 204 });
    }

    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  });

  return { uploadedKeys, deletedKeys, downloadedKeys, grants };
}

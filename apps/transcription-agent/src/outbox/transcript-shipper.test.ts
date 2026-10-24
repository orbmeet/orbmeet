import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIGNATURE_HEADER, verifySignedRequest } from "@orbmeet/primitives";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptJournal, type TranscriptPayload } from "./transcript-journal.js";
import {
  deliverTranscriptPayload,
  groupRowsForDelivery,
  runTranscriptShipper,
  shipJournalBatch,
  type DeliveryOutcome,
} from "./transcript-shipper.js";

const dirs: string[] = [];
let journal: TranscriptJournal;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "transcript-shipper-"));
  dirs.push(dir);
  journal = new TranscriptJournal(join(dir, "journal.db"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  journal.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function append(participant: string, segmentId: string, text = "said") {
  journal.append("m1", participant, { segmentId, startedAt: 1_000, language: "en-US", text });
}

const ids = (payload: TranscriptPayload) => payload.segments.map((segment) => segment.segmentId);

function appendIn(meetingId: string, participant: string, segmentId: string) {
  journal.append(meetingId, participant, { segmentId, startedAt: 1_000, language: "en-US", text: "said" });
}

describe("shipJournalBatch", () => {
  it("delivers each participant's rows in one request, even when speakers alternate", async () => {
    append("p1", "a");
    append("p2", "b");
    append("p1", "c");
    append("p2", "d");
    const sent: string[][] = [];
    const result = await shipJournalBatch(journal, async (payload) => {
      sent.push(ids(payload));
      return { kind: "committed" };
    }, { maxUnresolvedAgeMs: 60_000 });

    expect(sent).toEqual([["a", "c"], ["b", "d"]]);
    expect(result).toEqual({ delivered: 4, unavailable: false });
    expect(journal.status().pending).toBe(0);
  });

  it("holds back only a throttled meeting, and delivers every other meeting in the same pass", async () => {
    const now = 10_000;
    appendIn("busy", "p1", "a");
    appendIn("quiet", "p2", "b");
    appendIn("busy", "p3", "c");
    const sent: string[][] = [];
    const result = await shipJournalBatch(journal, async (payload) => {
      sent.push(ids(payload));
      return payload.meetingId === "busy"
        ? { kind: "throttled", reason: "429", retryAfterMs: 5_000 }
        : { kind: "committed" };
    }, { maxUnresolvedAgeMs: 60_000, now: () => now });

    // The busy meeting's second participant is not even asked: the limit is the meeting's.
    expect(sent).toEqual([["a"], ["b"]]);
    expect(result).toEqual({ delivered: 1, unavailable: false });
    expect(journal.pending(100, now + 4_999)).toEqual([]);
    expect(journal.pending(100, now + 5_000).map((row) => row.payload.segments[0].segmentId)).toEqual(["a", "c"]);
  });

  it("keeps every row while the app is unavailable, and stops the pass", async () => {
    append("p1", "a");
    append("p2", "b");
    const deliver = vi.fn(async (): Promise<DeliveryOutcome> => ({ kind: "unavailable", reason: "503" }));
    const result = await shipJournalBatch(journal, deliver, { maxUnresolvedAgeMs: 60_000 });

    expect(result).toEqual({ delivered: 0, unavailable: true });
    expect(deliver).toHaveBeenCalledOnce();
    expect(journal.status().pending).toBe(2);
  });

  it("retries a refused request a row at a time, setting aside only the row the app refuses", async () => {
    append("p1", "good");
    append("p1", "poison");
    const result = await shipJournalBatch(journal, async (payload) =>
      ids(payload).includes("poison") ? { kind: "refused", reason: "400" } : { kind: "committed" },
    { maxUnresolvedAgeMs: 60_000 });

    expect(result.delivered).toBe(1);
    expect(journal.status().pending).toBe(0);
  });

  it("steps unattributable rows out of the queue, so rows behind them still go", async () => {
    let now = 10_000;
    append("ghost", "a");
    append("p1", "b");
    const sent: string[][] = [];
    const deliver = async (payload: TranscriptPayload): Promise<DeliveryOutcome> => {
      sent.push(ids(payload));
      return payload.participantIdentity === "ghost"
        ? { kind: "unresolved", reason: "acknowledged 0 of 1" }
        : { kind: "committed" };
    };
    await shipJournalBatch(journal, deliver, { maxUnresolvedAgeMs: 600_000, now: () => now });
    await shipJournalBatch(journal, deliver, { maxUnresolvedAgeMs: 600_000, now: () => now });

    expect(sent).toEqual([["a"], ["b"]]);
    expect(journal.status().pending).toBe(1);
  });

  it("sets unattributable rows aside once they have waited long enough", async () => {
    append("ghost", "a");
    await shipJournalBatch(journal, async () => ({ kind: "unresolved", reason: "0 of 1" }), {
      maxUnresolvedAgeMs: 60_000,
      now: () => Date.now() + 120_000,
    });
    expect(journal.status().pending).toBe(0);
  });
});

describe("groupRowsForDelivery", () => {
  it("never exceeds the route's segment ceiling", () => {
    for (let index = 0; index < 150; index += 1) append("p1", `s${index}`);
    const batches = groupRowsForDelivery(journal.pending(200));
    expect(batches.map((batch) => batch.length)).toEqual([100, 50]);
  });

  it("keeps every request under the route's byte cap, counting multi-byte text as sent", () => {
    // 3 bytes per character in UTF-8, one per UTF-16 unit.
    for (let index = 0; index < 100; index += 1) append("p1", `s${index}`, "字".repeat(1_500));
    const batches = groupRowsForDelivery(journal.pending(200));
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const body = JSON.stringify({
        meetingId: "m1",
        participantIdentity: "p1",
        segments: batch.flatMap((row) => row.payload.segments),
      });
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(256 * 1_024);
    }
  });
});

describe("deliverTranscriptPayload", () => {
  const config = { appUrl: "https://app.example", internalKeyId: "agent", internalSecret: "s".repeat(32) };
  const payload: TranscriptPayload = {
    meetingId: "m1",
    participantIdentity: "p1",
    segments: [{ segmentId: "a", startedAt: 1_000, language: "en-US", text: "said" }],
  };

  it("signs the request and reads a full acknowledgement as committed", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ submitted: 1 }));
    await expect(deliverTranscriptPayload(config, payload, fetchImpl)).resolves.toEqual({ kind: "committed" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://app.example/api/internal/transcripts");
    const headers = init?.headers as Record<string, string>;
    // What the app's ingest route checks: this method and path, under the agent's key.
    await expect(verifySignedRequest({
      header: headers[SIGNATURE_HEADER],
      method: "POST",
      target: "/api/internal/transcripts",
      body: init?.body as string,
      keyring: new Map([["agent", config.internalSecret]]),
    })).resolves.toEqual({ ok: true, keyId: "agent" });
  });

  it("classifies what the app said", async () => {
    const outcome = (response: Response | Error) => deliverTranscriptPayload(config, payload, async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    expect((await outcome(Response.json({ submitted: 0 }))).kind).toBe("unresolved");
    expect((await outcome(new Response(null, { status: 400 }))).kind).toBe("refused");
    expect((await outcome(new Response(null, { status: 413 }))).kind).toBe("refused");
    expect((await outcome(new Response(null, { status: 401 }))).kind).toBe("unavailable");
    expect(await outcome(new Response(null, { status: 429 }))).toMatchObject({ kind: "throttled", retryAfterMs: 10_000 });
    expect(await outcome(new Response(null, { status: 429, headers: { "Retry-After": "3" } })))
      .toMatchObject({ kind: "throttled", retryAfterMs: 3_000 });
    expect(await outcome(new Response(null, { status: 429, headers: { "Retry-After": "3600" } })))
      .toMatchObject({ kind: "throttled", retryAfterMs: 60_000 });
    expect((await outcome(new Response(null, { status: 503 }))).kind).toBe("unavailable");
    expect((await outcome(new Error("ECONNRESET"))).kind).toBe("unavailable");
  });
});

describe("runTranscriptShipper", () => {
  it("ships rows appended while it runs, and stops when its scope aborts", async () => {
    const scope = new AbortController();
    const deliver = vi.fn(async (): Promise<DeliveryOutcome> => ({ kind: "committed" }));
    const running = runTranscriptShipper(journal, deliver, { maxUnresolvedAgeMs: 60_000, signal: scope.signal });
    append("p1", "a");
    await vi.waitFor(() => expect(journal.status().pending).toBe(0), { timeout: 3_000 });
    scope.abort();
    await running;
    expect(deliver).toHaveBeenCalled();
  });
});

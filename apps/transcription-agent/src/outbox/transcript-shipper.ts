import { SIGNATURE_HEADER, signatureTarget, signRequest } from "@orbmeet/primitives";
import {
  MAX_TRANSCRIPT_REQUEST_BYTES,
  MAX_TRANSCRIPT_SEGMENTS_PER_REQUEST,
  TRANSCRIPT_INGEST_PATH,
} from "@orbmeet/caption-protocol/transcript-ingest";
import { sleep } from "../abort.js";
import type { JournalRow, TranscriptJournal, TranscriptPayload } from "./transcript-journal.js";
import { logError, logWarn } from "../log.js";

const REQUEST_TIMEOUT_MS = 10_000;
const IDLE_POLL_MS = 1_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKLOG_REPORT_INTERVAL_MS = 60_000;
const REJECTED_RETENTION_MS = 8 * 24 * 60 * 60 * 1_000;
const REJECTED_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
/** How long an unattributable row waits before it is offered to the app again. */
const UNRESOLVED_RETRY_MS = 30_000;
/** How long a throttled meeting's rows wait when the app does not say. */
const THROTTLED_RETRY_MS = 10_000;
/** The longest `Retry-After` honoured: the app's rate windows are a minute. */
const MAX_THROTTLED_RETRY_MS = 60_000;
/** Room in the body for what is not a segment: the envelope and its ids. */
const REQUEST_ENVELOPE_BYTES = 4 * 1_024;

const utf8 = new TextEncoder();

export interface IngestConfig {
  appUrl: string;
  internalKeyId: string;
  internalSecret: string;
}

/**
 * What the app said about one delivery.
 *
 * - `committed`: every segment is in D1; the rows may be deleted.
 * - `refused`: the request itself is invalid and will never be accepted.
 * - `unresolved`: the app could not attribute the segments yet; the
 *   participant may still become resolvable.
 * - `throttled`: the app is pacing this meeting's ingest (its limit is per
 *   meeting). Only this meeting waits; every other meeting keeps going.
 * - `unavailable`: anything else. Nothing is lost by trying again later.
 */
export type DeliveryOutcome =
  | { kind: "committed" }
  | { kind: "refused"; reason: string }
  | { kind: "unresolved"; reason: string }
  | { kind: "throttled"; reason: string; retryAfterMs: number }
  | { kind: "unavailable"; reason: string };

export type DeliverTranscripts = (payload: TranscriptPayload) => Promise<DeliveryOutcome>;

/** POST one payload to the app's signed transcript ingest route. */
export async function deliverTranscriptPayload(
  config: IngestConfig,
  payload: TranscriptPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryOutcome> {
  const body = JSON.stringify(payload);
  const url = `${config.appUrl}${TRANSCRIPT_INGEST_PATH}`;
  const signature = await signRequest({
    method: "POST",
    target: signatureTarget(url),
    body,
    keyring: new Map([[config.internalKeyId, config.internalSecret]]),
  });

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: signature },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    const reason = `transcript ingest returned ${response.status}`;
    if (response.status === 429) {
      return { kind: "throttled", reason, retryAfterMs: retryAfterMs(response.headers.get("Retry-After")) };
    }
    // These describe the request, not the service. An authentication failure
    // stays retryable: a rotated secret is an operator repair, not permission
    // to lose speech.
    return [400, 413, 422].includes(response.status)
      ? { kind: "refused", reason }
      : { kind: "unavailable", reason };
  }
  const result = await response.json().catch(() => null) as { submitted?: unknown } | null;
  if (result?.submitted === payload.segments.length) return { kind: "committed" };
  return {
    kind: "unresolved",
    reason: `transcript ingest acknowledged ${String(result?.submitted)} of ${payload.segments.length} segments`,
  };
}

/** A `Retry-After` in seconds, bounded; the default when absent or unreadable. */
function retryAfterMs(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return THROTTLED_RETRY_MS;
  return Math.min(seconds * 1_000, MAX_THROTTLED_RETRY_MS);
}

/**
 * Group journal rows into as few requests as the route allows: one request
 * per participant, split only at the route's segment and byte ceilings.
 *
 * A conversation's speakers alternate, so grouping consecutive rows alone
 * spent a request per final, and a lively meeting reached its ingest limit.
 * Order across participants does not matter to the app, which places every
 * segment by its own `startedAt`; within a participant, rows keep journal
 * order. Batches come out in the order each participant first appears.
 */
export function groupRowsForDelivery(rows: readonly JournalRow[]): JournalRow[][] {
  const batches: JournalRow[][] = [];
  const open = new Map<string, { rows: JournalRow[]; segments: number; bytes: number }>();
  for (const row of rows) {
    // Measured as sent: serialized and UTF-8 encoded, each with its separator.
    const bytes = row.payload.segments.reduce(
      (total, segment) => total + utf8.encode(JSON.stringify(segment)).byteLength + 1,
      0,
    );
    const key = JSON.stringify([row.payload.meetingId, row.payload.participantIdentity]);
    const batch = open.get(key);
    if (
      batch &&
      batch.segments + row.payload.segments.length <= MAX_TRANSCRIPT_SEGMENTS_PER_REQUEST &&
      batch.bytes + bytes <= MAX_TRANSCRIPT_REQUEST_BYTES - REQUEST_ENVELOPE_BYTES
    ) {
      batch.rows.push(row);
      batch.segments += row.payload.segments.length;
      batch.bytes += bytes;
      continue;
    }
    const next = { rows: [row], segments: row.payload.segments.length, bytes };
    open.set(key, next);
    batches.push(next.rows);
  }
  return batches;
}

function payloadFor(rows: readonly JournalRow[]): TranscriptPayload {
  return {
    meetingId: rows[0].payload.meetingId,
    participantIdentity: rows[0].payload.participantIdentity,
    segments: rows.flatMap((row) => row.payload.segments),
  };
}

export interface ShipResult {
  /** Rows the app committed. */
  delivered: number;
  /** The app could not be reached; the caller should back off. */
  unavailable: boolean;
}

/**
 * Deliver the oldest journal rows once.
 *
 * A row is deleted only after the app committed it. A request the app refuses
 * as invalid is retried a row at a time, so one bad row cannot take its
 * neighbours with it; a single refused row is set aside. Unattributable rows
 * step out of the queue for a while and are offered again, for up to
 * `maxUnresolvedAgeMs`, then are set aside.
 *
 * The app's ingest limit is per meeting, so a throttled meeting steps out of
 * the queue on its own until the app's `Retry-After`: its rows in this pass
 * are deferred unsent, and every other meeting's are still delivered. Only an
 * app that cannot be reached at all stops the pass.
 */
export async function shipJournalBatch(
  journal: TranscriptJournal,
  deliver: DeliverTranscripts,
  options: { maxUnresolvedAgeMs: number; now?: () => number },
): Promise<ShipResult> {
  const now = options.now ?? Date.now;
  let delivered = 0;
  /** Meetings the app throttled during this pass, and until when. */
  const throttled = new Map<string, number>();
  const ship = async (rows: JournalRow[]): Promise<"ok" | "unavailable"> => {
    const { meetingId } = rows[0].payload;
    const waitUntil = throttled.get(meetingId);
    if (waitUntil !== undefined) {
      journal.defer(rows.map((row) => row.id), waitUntil);
      return "ok";
    }
    const outcome = await deliver(payloadFor(rows));
    switch (outcome.kind) {
      case "committed":
        journal.acknowledge(rows.map((row) => row.id));
        delivered += rows.length;
        return "ok";
      case "refused":
        if (rows.length > 1) {
          for (const row of rows) {
            if (await ship([row]) === "unavailable") return "unavailable";
          }
          return "ok";
        }
        journal.reject([rows[0].id], outcome.reason);
        return "ok";
      case "throttled": {
        const until = now() + outcome.retryAfterMs;
        throttled.set(meetingId, until);
        journal.defer(rows.map((row) => row.id), until);
        logWarn("Transcript ingest throttled a meeting; its rows wait", {
          meetingId,
          retryAfterMs: outcome.retryAfterMs,
        });
        return "ok";
      }
      case "unresolved": {
        const expired = rows.filter((row) => now() - row.createdAt >= options.maxUnresolvedAgeMs);
        const waiting = rows.filter((row) => now() - row.createdAt < options.maxUnresolvedAgeMs);
        if (expired.length > 0) journal.reject(expired.map((row) => row.id), outcome.reason);
        if (waiting.length > 0) journal.defer(waiting.map((row) => row.id), now() + UNRESOLVED_RETRY_MS);
        return "ok";
      }
      case "unavailable":
        logWarn("Transcript ingest unavailable; rows stay journaled", { reason: outcome.reason });
        return "unavailable";
    }
  };

  for (const batch of groupRowsForDelivery(journal.pending(100, now()))) {
    if (await ship(batch) === "unavailable") return { delivered, unavailable: true };
  }
  return { delivered, unavailable: false };
}

/**
 * The parent process's delivery loop: ships continuously while there is a
 * backlog, polls while idle, and backs off while the app is unreachable.
 * Aborting `signal` ends it after the request in flight.
 */
export async function runTranscriptShipper(
  journal: TranscriptJournal,
  deliver: DeliverTranscripts,
  options: { maxUnresolvedAgeMs: number; signal: AbortSignal },
): Promise<void> {
  let backoffMs = MIN_BACKOFF_MS;
  let lastBacklogReportAt = 0;
  let lastPruneAt = 0;
  while (!options.signal.aborted) {
    let result: ShipResult;
    try {
      result = await shipJournalBatch(journal, deliver, options);
    } catch (error) {
      logError("Transcript shipping pass failed; rows stay journaled", error);
      result = { delivered: 0, unavailable: true };
    }

    const now = Date.now();
    if (now - lastBacklogReportAt >= BACKLOG_REPORT_INTERVAL_MS) {
      lastBacklogReportAt = now;
      const backlog = journal.status();
      if (backlog.pending > 0) {
        logWarn("Transcript delivery backlog", {
          pending: backlog.pending,
          oldestAgeMs: backlog.oldestAt === null ? 0 : now - backlog.oldestAt,
        });
      }
    }
    if (now - lastPruneAt >= REJECTED_PRUNE_INTERVAL_MS) {
      lastPruneAt = now;
      journal.pruneRejected(REJECTED_RETENTION_MS, now);
    }

    if (result.unavailable) {
      await sleep(backoffMs, options.signal);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      continue;
    }
    backoffMs = MIN_BACKOFF_MS;
    if (result.delivered === 0) await sleep(IDLE_POLL_MS, options.signal);
  }
}

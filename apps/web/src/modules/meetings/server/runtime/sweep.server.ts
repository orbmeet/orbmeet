import "@tanstack/react-start/server-only";
import { createDb } from "@orbmeet/db";
import { meetings } from "@orbmeet/db/schema";
import { and, eq, lt, sql } from "drizzle-orm";
import { logError } from "@/lib/logger";
import { callCoordinator } from "./client.server";

/** How long an open meeting's row may stay unchanged before it is checked on. */
const QUIET_MS = 10 * 60_000;
const SWEEP_EVERY_MINUTES = 10;
const SWEEP_LIMIT = 50;

/**
 * The safety net under every open meeting whose row has gone quiet. A room
 * keeps its own durable alarm, but a meeting whose creating request failed
 * before the first join has no room yet, and a room can lose its alarm or its
 * state. Waking one creates or ticks its room: a meeting nobody joined is
 * discarded, one that emptied ends, and a healthy one only ticks. A room that
 * cannot be woken is logged every sweep, so a stuck meeting is visible.
 *
 * The batch is drawn at random, so rows that keep failing to wake cannot hold
 * the same places every tick.
 */
export async function sweepQuietMeetings(env: Env, now: Date): Promise<void> {
  if (now.getUTCMinutes() % SWEEP_EVERY_MINUTES !== 0) return;
  const db = createDb(env.DB);
  const rows = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(and(
      eq(meetings.status, "open"),
      lt(meetings.updatedAt, new Date(now.getTime() - QUIET_MS)),
    ))
    .orderBy(sql`random()`)
    .limit(SWEEP_LIMIT);
  await Promise.all(rows.map(async ({ id }) => {
    try {
      await callCoordinator(env, { kind: "wake", meetingId: id });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "MEETING_ENDED" || code === "NOT_FOUND") return;
      logError("[meetings] Could not wake a meeting", { meetingId: id }, error);
    }
  }));
}

import "@tanstack/react-start/server-only";
import type { Database } from "@orbmeet/db";
import { nodeHealth, type NODE_SERVICES } from "@orbmeet/db/schema";
import { eq, sql } from "drizzle-orm";
import { parseSyncHealth, speaksWith, SYNC_PROTOCOL } from "@orbmeet/whiteboard-core/sync-commands";
import { logError, logWarn } from "@/lib/logger";
import { createRoomServiceClient } from "./livekit-clients.server";
import type { MediaNode, WhiteboardNode } from "./nodes";

// Each service of each node is probed apart, so a LiveKit restart moves only
// Meetings and a sync server restart only boards. One failed probe is often a
// blip between Cloudflare and the node, so it only stops new work going
// there. Two in a row, including a client's report confirmed by a probe, mean
// the service is down and its work may move.
const DOWN_AFTER_FAILURES = 2;
const PROBE_TIMEOUT_SECONDS = 5;

export type NodeService = (typeof NODE_SERVICES)[number];
export type NodeHealthRow = typeof nodeHealth.$inferSelect;

/** Whether new work may go to the service: its latest probe succeeded. */
export function isServiceHealthy(row: NodeHealthRow | undefined): boolean {
  return row?.failures === 0;
}

/** Whether the service's work should move: probes have failed repeatedly. */
export function isServiceDown(row: NodeHealthRow | undefined): boolean {
  return (row?.failures ?? 0) >= DOWN_AFTER_FAILURES;
}

/** The latest probe of `service` on every node, by node id. */
export async function readNodeHealth(
  db: Database,
  service: NodeService,
): Promise<ReadonlyMap<string, NodeHealthRow>> {
  const rows = await db.select().from(nodeHealth).where(eq(nodeHealth.service, service));
  return new Map(rows.map((row) => [row.nodeId, row]));
}

/**
 * The names of the rooms the node hosts, listed through its public URL with
 * the key the Worker signs with, so a success proves the path clients and the
 * Worker use. Null when the node cannot be reached or refuses.
 */
export async function probeMediaNode(node: MediaNode): Promise<string[] | null> {
  try {
    const rooms = await createRoomServiceClient(node, PROBE_TIMEOUT_SECONDS).listRooms();
    return rooms.map((room) => room.name);
  } catch (error) {
    logWarn("[nodes] Media probe failed", { node: node.id }, error);
    return null;
  }
}

/**
 * Whether the node's sync server answers its health check at its public URL,
 * the way clients reach it, and speaks a sync protocol this Worker reads (and
 * reads the one this Worker speaks). A node a deploy left on an incompatible
 * protocol is as unusable as one that is down, and boards move off it.
 */
export async function probeWhiteboardNode(node: WhiteboardNode): Promise<boolean> {
  try {
    const response = await fetch(`${node.whiteboardUrl}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_SECONDS * 1000),
    });
    if (response.ok) {
      const health = parseSyncHealth(await response.json().catch(() => null));
      if (health && speaksWith(SYNC_PROTOCOL, health.protocol)) return true;
      logError("[nodes] Whiteboard speaks a sync protocol this Worker cannot use", { node: node.id, protocol: health?.protocol ?? "unreadable" });
      return false;
    }
    logWarn("[nodes] Whiteboard probe answered an error", { node: node.id, status: response.status });
  } catch (error) {
    logWarn("[nodes] Whiteboard probe failed", { node: node.id }, error);
  }
  return false;
}

/** Record one probe's outcome and return the service's row after it. */
export async function recordNodeProbe(
  db: Database,
  nodeId: string,
  service: NodeService,
  ok: boolean,
  now: Date,
): Promise<NodeHealthRow> {
  const [row] = await db
    .insert(nodeHealth)
    .values({ nodeId, service, checkedAt: now, failures: ok ? 0 : 1, failingSince: ok ? null : now })
    .onConflictDoUpdate({
      target: [nodeHealth.nodeId, nodeHealth.service],
      set: {
        checkedAt: now,
        failures: ok ? 0 : sql`${nodeHealth.failures} + 1`,
        failingSince: ok ? null : sql`coalesce(${nodeHealth.failingSince}, ${Math.floor(now.getTime() / 1000)})`,
      },
    })
    .returning();
  return row;
}

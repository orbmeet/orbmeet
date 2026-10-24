import "@tanstack/react-start/server-only";
import { NEAR_MS, placeNode, type NodeLatencies } from "@orbmeet/nodes";
import type { Database } from "@orbmeet/db";
import { meetings, meetingWhiteboards, whiteboards } from "@orbmeet/db/schema";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { and, eq, ne, sql } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { logWarn } from "@/lib/logger";
import {
  isServiceDown,
  probeWhiteboardNode,
  readNodeHealth,
  recordNodeProbe,
} from "@/platform/realtime/node-health.server";
import { whiteboardNodes, type WhiteboardNode } from "./config.server";
import { isUnreachable, postSyncCommand } from "./sync-command-transport.server";

/**
 * Which node holds each board.
 *
 * A board lives on one node at a time, the one its row names, at the
 * generation its row gives it. Every command and token for it goes there, and
 * carries the generation: a node holding an older copy loads the newest saved
 * one first, and a node the board has moved on from is refused everything.
 *
 * A board goes where whoever uses it is: beside the media of a live Meeting
 * that shows it, unless another live Meeting has it there already; when no
 * one is using it, near whoever opens it next; and off a node whose sync
 * server is down or retiring (weight 0). Moving, its node hands it off (saves
 * it to R2 and sends its clients back to the Worker) and the row moves it on,
 * one generation up. Only the sync server's own health counts: a LiveKit
 * restart moves no board.
 */

/** Where a board is, and the generation every command and token for it carries. */
export interface BoardPlacement {
  node: WhiteboardNode;
  generation: number;
}

/** Who needs the board, which decides where it should be. */
export type PlacementIntent =
  /** Shown in a Meeting: next to the Meeting's media, unless another live Meeting has it there already. */
  | { kind: "meeting"; meetingId: string; mediaNodeId: string | null }
  /** Opened by someone on their own: near them, once no one is using it where it is. */
  | { kind: "editor"; latencies: NodeLatencies }
  /** A command or the recorder: wherever it is. */
  | { kind: "service" };

/** The node a board goes to when it has nowhere better to be: see @orbmeet/nodes' `placeNode`. */
function pickNode(
  nodes: readonly WhiteboardNode[],
  up: (node: WhiteboardNode) => boolean,
  latencies: NodeLatencies,
  spreadKey: string,
): WhiteboardNode | null {
  return placeNode(nodes.filter(up), { latency: (node) => latencies[node.id], spreadKey });
}

/** Whether an open Meeting uses the board, other than `meetingId` and, when given, on `nodeId` only. */
async function inUseByMeeting(
  db: Database,
  whiteboardId: string,
  { exceptMeetingId, nodeId }: { exceptMeetingId?: string; nodeId?: string } = {},
): Promise<boolean> {
  const [row] = await db
    .select({ id: meetings.id })
    .from(meetingWhiteboards)
    .innerJoin(meetings, eq(meetings.id, meetingWhiteboards.meetingId))
    .where(and(
      eq(meetingWhiteboards.whiteboardId, whiteboardId),
      eq(meetings.status, "open"),
      nodeId === undefined ? undefined : eq(meetings.mediaNodeId, nodeId),
      exceptMeetingId === undefined ? undefined : ne(meetings.id, exceptMeetingId),
    ))
    .limit(1);
  return Boolean(row);
}

/** Where the board should be for `intent`, and whether it may move there only if no one is using it now. */
interface BoardTarget {
  node: WhiteboardNode;
  ifIdle: boolean;
}

/**
 * The node a board should be on for `intent`, given where it is. Nodes whose
 * sync servers keep failing their probes are passed over; a retiring node
 * keeps a board only for commands, never for someone opening it.
 */
async function chooseBoardNode(
  db: Database,
  board: { id: string },
  nodes: readonly WhiteboardNode[],
  holder: WhiteboardNode | null,
  up: (node: WhiteboardNode) => boolean,
  intent: PlacementIntent,
): Promise<BoardTarget | null> {
  const holderUp = holder !== null && up(holder);
  if (intent.kind === "meeting" && intent.mediaNodeId && intent.mediaNodeId !== holder?.id) {
    const meetingNode = nodes.find((node) => node.id === intent.mediaNodeId);
    if (
      meetingNode
      && up(meetingNode)
      && !(holderUp && await inUseByMeeting(db, board.id, { exceptMeetingId: intent.meetingId, nodeId: holder.id }))
    ) {
      return { node: meetingNode, ifIdle: false };
    }
  }
  if (holderUp && holder.weight > 0 && intent.kind === "editor") {
    // Someone opening it on their own, for whom another node is clearly
    // faster than its own: it goes to them, unless a Meeting shows it or
    // someone is using it there.
    const nearest = pickNode(nodes, up, intent.latencies, board.id);
    const fast = nearest ? intent.latencies[nearest.id] : undefined;
    const own = intent.latencies[holder.id];
    if (
      nearest
      && fast !== undefined
      && (own === undefined || own > fast + NEAR_MS)
      && !await inUseByMeeting(db, board.id)
    ) {
      return { node: nearest, ifIdle: true };
    }
  }
  if (holderUp && (holder.weight > 0 || intent.kind === "service")) return { node: holder, ifIdle: false };
  // Nothing answers: leave the board where it is rather than move it blind.
  const fallback = pickNode(nodes, up, intent.kind === "editor" ? intent.latencies : {}, board.id) ?? holder;
  return fallback && { node: fallback, ifIdle: false };
}

/**
 * Where the board whose sync room is `syncRoomId` lives for `intent`,
 * moving it there first when it should be elsewhere. Null when no board has
 * that room (one being created, or one deleted).
 */
export async function placeBoard(
  db: Database,
  env: Env,
  syncRoomId: string,
  intent: PlacementIntent,
): Promise<BoardPlacement | null> {
  const nodes = whiteboardNodes(env);
  if (nodes.length === 0) throw Errors.CONFIG_ERROR("Whiteboard not configured");
  for (let attempt = 0; attempt < 3; attempt++) {
    const board = await db.query.whiteboards.findFirst({
      where: { syncRoomId },
      columns: { id: true, syncNodeId: true, syncGeneration: true },
    });
    if (!board) return null;
    const health = await readNodeHealth(db, "whiteboard");
    const up = (node: WhiteboardNode) => !isServiceDown(health.get(node.id));
    const holder = nodes.find((node) => node.id === board.syncNodeId) ?? null;
    const choice = await chooseBoardNode(db, board, nodes, holder, up, intent);
    if (!choice) throw Errors.CONFIG_ERROR("Whiteboard not configured");
    const target = choice.node;
    if (target.id === holder?.id) return { node: holder, generation: board.syncGeneration };

    if (holder && up(holder)) {
      const handoff = await postSyncCommand(holder, "handoff", {
        whiteboardRoomId: toWhiteboardRoomId(syncRoomId),
        whiteboardId: board.id,
        generation: board.syncGeneration,
        ...(choice.ifIdle ? { ifIdle: true } : {}),
      });
      // A move toward an editor happens only on a confirmed save of an idle
      // board: someone using it there (`busy`), or any failure, keeps it
      // where it is, which costs the editor only distance.
      if (!handoff.ok && choice.ifIdle) return { node: holder, generation: board.syncGeneration };
      // A node that answered but could not save keeps the board: moving it
      // would lose what it holds. One whose sync server cannot be reached is
      // moved off, and its sockets are refused at their next authority check.
      if (!handoff.ok && !isUnreachable(handoff)) {
        logWarn("[whiteboard] board kept on its node: the handoff failed", {
          whiteboardId: board.id,
          node: holder.id,
          reason: handoff.reason,
        });
        return { node: holder, generation: board.syncGeneration };
      }
    }
    const generation = board.syncGeneration + 1;
    const [moved] = await db
      .update(whiteboards)
      // A move is not an edit: the board keeps its place in "recently updated".
      .set({ syncNodeId: target.id, syncGeneration: generation, updatedAt: sql`${whiteboards.updatedAt}` })
      .where(and(eq(whiteboards.id, board.id), eq(whiteboards.syncGeneration, board.syncGeneration)))
      .returning({ id: whiteboards.id });
    if (moved) return { node: target, generation };
    // Another request moved it first: start over from where it went.
  }
  throw Errors.CONFLICT("The whiteboard is moving; try again");
}

/**
 * Where a board that does not exist yet is created: of the nodes whose sync
 * servers answer, the one fastest for whoever it is for, ties spread by
 * `spreadKey`.
 */
export async function nodeForNewBoard(
  db: Database,
  env: Env,
  latencies: NodeLatencies,
  spreadKey: string,
): Promise<WhiteboardNode> {
  const nodes = whiteboardNodes(env);
  const health = await readNodeHealth(db, "whiteboard");
  const node = pickNode(nodes, (candidate) => !isServiceDown(health.get(candidate.id)), latencies, spreadKey)
    ?? pickNode(nodes, () => true, latencies, spreadKey);
  if (!node) throw Errors.CONFIG_ERROR("Whiteboard not configured");
  return node;
}

/** Every node that may hold a copy of a board and answers: a purge reaches them all. */
export async function liveWhiteboardNodes(db: Database, env: Env): Promise<WhiteboardNode[]> {
  const health = await readNodeHealth(db, "whiteboard");
  return whiteboardNodes(env).filter((node) => !isServiceDown(health.get(node.id)));
}

/**
 * The minutely check of every sync server, at its public URL: boards move
 * off one that keeps failing. Throws while any is down, so the cron alerts
 * even when nobody is drawing; one failed probe is often a blip, and only its
 * warning is logged.
 */
export async function checkWhiteboardNodes(db: Database, env: Pick<Env, "NODES">, now = new Date()): Promise<void> {
  const down: string[] = [];
  await Promise.all(whiteboardNodes(env).map(async (node) => {
    const ok = await probeWhiteboardNode(node);
    const health = await recordNodeProbe(db, node.id, "whiteboard", ok, now);
    if (isServiceDown(health)) down.push(node.id);
  }));
  if (down.length > 0) {
    throw new Error(`Whiteboard nodes failed their probe: ${down.sort().join(", ")}`);
  }
}

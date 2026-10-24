import "@tanstack/react-start/server-only";
import type { Database } from "@orbmeet/db";
import { meetingConnections, meetings } from "@orbmeet/db/schema";
import { placeNode, type NodeLatencies } from "@orbmeet/nodes";
import { and, count, countDistinct, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { logError, logWarn } from "@/lib/logger";
import { boundedStatements } from "@/platform/database/db-batching";
import { createRoomServiceClient } from "@/platform/realtime/livekit-clients.server";
import { mediaNodes, type MediaNode } from "@/platform/realtime/nodes";
import {
  isServiceDown,
  isServiceHealthy,
  probeMediaNode,
  readNodeHealth,
  recordNodeProbe,
  type NodeHealthRow,
} from "@/platform/realtime/node-health.server";
import { connectionIsPresent } from "../connection/state";
import {
  liveKitMeetingRoomName,
  meetingIdFromLiveKitRoom,
  type LiveKitMeetingRoomName,
} from "@/modules/meetings/contract/livekit-room";

/** A placed Meeting's LiveKit room: the node that hosts it and the room's name. */
export interface MeetingMediaRoom {
  meetingId: string;
  roomName: LiveKitMeetingRoomName;
  node: MediaNode;
}

/**
 * The room of a Meeting row that carries its placement. Null when the Meeting
 * was never placed (no participant was ever admitted, so no room exists) or
 * when its node has left NODES, taking its rooms with it.
 */
function meetingMediaRoom(
  env: Pick<Env, "NODES">,
  meeting: { id: string; mediaNodeId: string | null },
): MeetingMediaRoom | null {
  const node = meeting.mediaNodeId ? mediaNodes(env).get(meeting.mediaNodeId) : undefined;
  return node
    ? { meetingId: meeting.id, roomName: liveKitMeetingRoomName(meeting.id), node }
    : null;
}

/** `meetingMediaRoom` for a Meeting known only by id. */
export async function findMeetingMediaRoom(
  db: Database,
  env: Pick<Env, "NODES">,
  meetingId: string,
): Promise<MeetingMediaRoom | null> {
  const meeting = await db.query.meetings.findFirst({
    where: { id: meetingId },
    columns: { id: true, mediaNodeId: true },
  });
  return meeting ? meetingMediaRoom(env, meeting) : null;
}

/**
 * The node a new or displaced Meeting should go to, of those whose LiveKit
 * answered its latest probe: see @orbmeet/nodes' `placeNode`. Load is open
 * Meetings plus live participants, against each node's capacity, so a full
 * region's next Meeting goes to the next-nearest region.
 */
function chooseMediaNode(
  nodes: readonly MediaNode[],
  health: ReadonlyMap<string, NodeHealthRow>,
  load: ReadonlyMap<string, number>,
  latencies: NodeLatencies,
): MediaNode | null {
  return placeNode(nodes.filter((node) => isServiceHealthy(health.get(node.id))), {
    latency: (node) => latencies[node.id],
    load: (node) => load.get(node.id) ?? 0,
    capacity: (node) => node.capacity,
  });
}

/** Open Meetings plus live participants per node. */
async function readMediaNodeLoad(db: Database): Promise<ReadonlyMap<string, number>> {
  const rows = await db
    .select({
      nodeId: meetings.mediaNodeId,
      meetings: countDistinct(meetings.id),
      participants: count(meetingConnections.id),
    })
    .from(meetings)
    .leftJoin(
      meetingConnections,
      and(
        eq(meetingConnections.meetingId, meetings.id),
        connectionIsPresent(),
      ),
    )
    .where(and(eq(meetings.status, "open"), isNotNull(meetings.mediaNodeId)))
    .groupBy(meetings.mediaNodeId);
  return new Map(rows.map((row) => [row.nodeId!, row.meetings + row.participants]));
}

/** Probe nodes now, record the outcomes, and return the health they leave. */
async function probeNow(
  db: Database,
  nodes: readonly MediaNode[],
  health: ReadonlyMap<string, NodeHealthRow>,
  now: Date,
): Promise<ReadonlyMap<string, NodeHealthRow>> {
  const rows = await Promise.all(
    nodes.map(async (node) => recordNodeProbe(db, node.id, "media", (await probeMediaNode(node)) !== null, now)),
  );
  return new Map([...health, ...rows.map((row) => [row.nodeId, row] as const)]);
}

/**
 * The node an open Meeting should use, given the node it is on now (if any),
 * the signalling URL a rejoining client just failed to reach (if any), and
 * where the joiner is (if known), which places a Meeting that needs a node.
 *
 * A Meeting stays on its node unless the node is down (its probes failed
 * repeatedly) or has left NODES. A client that cannot reach the node
 * says so when it rejoins, and the node is probed on the spot; if the probe
 * fails too, the Meeting moves with that rejoin rather than waiting for the
 * minutely probe. Only probe outcomes are written here: moving the Meeting is
 * its coordinator's decision, recorded in its own state.
 */
export async function choosePlacement(
  db: Database,
  env: Pick<Env, "NODES">,
  currentNodeId: string | null,
  unreachableMediaUrl: string | null,
  latencies: NodeLatencies,
  now = new Date(),
): Promise<MediaNode> {
  const nodes = [...mediaNodes(env).values()];
  let health = await readNodeHealth(db, "media");
  const current = currentNodeId ? mediaNodes(env).get(currentNodeId) : undefined;
  let confirmedUnreachable = false;
  if (current) {
    if (unreachableMediaUrl === current.url && !isServiceDown(health.get(current.id))) {
      health = await probeNow(db, [current], health, now);
      // The client and the Worker both failed to reach the node: two
      // observers agree, so move now rather than wait for another probe.
      confirmedUnreachable = !isServiceHealthy(health.get(current.id));
    }
    if (!confirmedUnreachable && !isServiceDown(health.get(current.id))) return current;
  }

  const load = await readMediaNodeLoad(db);
  let target = chooseMediaNode(nodes, health, load, latencies);
  if (!target) {
    // No node is known to be healthy: before the first probe, or after an
    // outage the minutely probe has not yet seen end. Ask them now rather
    // than refuse the join.
    health = await probeNow(db, nodes.filter((node) => node.weight > 0), health, now);
    target = chooseMediaNode(nodes, health, load, latencies);
  }
  // Its own node answered after all. Unless a client just failed to reach it,
  // an answer outweighs the failures that marked it down: its participants
  // may never have lost it.
  if (current && !confirmedUnreachable && isServiceHealthy(health.get(current.id))) return current;
  if (!target) throw Errors.MEDIA_UNAVAILABLE();
  return target;
}

/**
 * Rooms the node still hosts for open Meetings placed on another node: the
 * node was taken for down and its Meetings moved, but it kept running. Rooms
 * of ended Meetings are left to teardown.
 */
async function abandonedRooms(db: Database, node: MediaNode, rooms: readonly string[]): Promise<string[]> {
  const byMeeting = new Map<string, string>();
  for (const room of rooms) {
    const meetingId = meetingIdFromLiveKitRoom(room);
    if (meetingId) byMeeting.set(meetingId, room);
  }
  const abandoned: string[] = [];
  // A node hosts any number of rooms.
  const lookups = boundedStatements([...byMeeting.keys()], (ids) =>
    db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(
        inArray(meetings.id, ids),
        eq(meetings.status, "open"),
        ne(meetings.mediaNodeId, node.id),
      )));
  for (const lookup of lookups) {
    abandoned.push(...(await lookup).map(({ id }) => byMeeting.get(id)!));
  }
  return abandoned;
}

/**
 * Close a room its Meeting has left. Removing each participant first tells
 * their clients to ask to join again, which sends them to the Meeting's
 * current node; deleting the room alone would tell them the Meeting ended.
 */
async function closeAbandonedRoom(node: MediaNode, room: string): Promise<void> {
  const roomService = createRoomServiceClient(node);
  const participants = await roomService.listParticipants(room);
  await Promise.all(participants.map((p) => roomService.removeParticipant(room, p.identity)));
  await roomService.deleteRoom(room);
}

/**
 * Rooms a node holds for Meetings that are over and drained. Nothing tears
 * these down: a drained Meeting's coordinator has let its state go and
 * answers every report about it with "ended". Yet LiveKit creates a room for
 * any participant presenting a token that has not expired, so a participant
 * reconnecting with a cached token recreates the room after its Meeting is
 * gone, and others can join them there. Only Meetings this deployment knows
 * are drained are judged: a room it has no row for may be another
 * deployment's on a shared node.
 */
async function drainedMeetingRooms(db: Database, rooms: readonly string[]): Promise<string[]> {
  const byMeeting = new Map<string, string>();
  for (const room of rooms) {
    const meetingId = meetingIdFromLiveKitRoom(room);
    if (meetingId) byMeeting.set(meetingId, room);
  }
  const drained: string[] = [];
  const lookups = boundedStatements([...byMeeting.keys()], (ids) =>
    db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(inArray(meetings.id, ids), isNotNull(meetings.drainedAt))));
  for (const lookup of lookups) {
    drained.push(...(await lookup).map(({ id }) => byMeeting.get(id)!));
  }
  return drained;
}

/**
 * Close whichever of `rooms` on `node` belong to drained Meetings. Deleting
 * the room disconnects everyone in it, as the Meeting's end did.
 */
export async function closeDrainedMeetingRooms(
  db: Database,
  node: MediaNode,
  rooms: readonly string[],
): Promise<void> {
  const drained = await drainedMeetingRooms(db, rooms);
  if (drained.length === 0) return;
  const roomService = createRoomServiceClient(node);
  const results = await Promise.allSettled(drained.map((room) => roomService.deleteRoom(room)));
  const failures: unknown[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      logWarn("[media-nodes] Closed a room whose Meeting is over", { room: drained[index], node: node.id });
    } else {
      failures.push(result.reason);
    }
  });
  if (failures.length > 0) {
    throw new AggregateError(failures, `Could not close ${failures.length} room(s) of drained Meetings on ${node.id}`);
  }
}

/**
 * The minutely check: probe every configured node, record the outcome, and
 * close the rooms a node still holds for Meetings that moved away or are
 * over. Throws while any node is down, so the cron alerts even when nobody
 * is joining; one failed probe is often a blip, and only its warning is logged.
 */
export async function checkMediaNodes(
  db: Database,
  env: Pick<Env, "NODES">,
  now = new Date(),
): Promise<void> {
  const down: string[] = [];
  await Promise.all([...mediaNodes(env).values()].map(async (node) => {
    const rooms = await probeMediaNode(node);
    const health = await recordNodeProbe(db, node.id, "media", rooms !== null, now);
    if (rooms === null) {
      if (isServiceDown(health)) down.push(node.id);
      return;
    }
    // Webhooks are not delivered reliably, so this is what finally closes a
    // room recreated after its Meeting ended.
    await closeDrainedMeetingRooms(db, node, rooms).catch((error: unknown) => {
      logError("[media-nodes] Could not close rooms of drained Meetings", { node: node.id }, error);
    });
    const abandoned = await abandonedRooms(db, node, rooms);
    const results = await Promise.allSettled(abandoned.map((room) => closeAbandonedRoom(node, room)));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        logWarn("[media-nodes] Closed a room whose Meeting moved to another node", { room: abandoned[index], node: node.id });
      } else {
        logError("[media-nodes] Could not close a room whose Meeting moved", { room: abandoned[index], node: node.id }, result.reason);
      }
    });
  }));
  if (down.length > 0) {
    throw new Error(`Media nodes failed their probe: ${down.sort().join(", ")}`);
  }
}

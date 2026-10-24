import "@tanstack/react-start/server-only";
import type { Database } from "@orbmeet/db";
import { meetingLinks, meetings } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import {
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  StreamOutput,
  StreamProtocol,
  TrackSource,
  type EgressInfo,
  type ParticipantInfo,
} from "livekit-server-sdk";
import type { MeetingRole } from "@/modules/meetings/contract/constants";
import { liveKitMeetingRoomName } from "@/modules/meetings/contract/livekit-room";
import { getWhiteboardRecorderCustomBaseUrl } from "@/modules/whiteboards/server/orchestration.server";
import { isWhiteboardConfigured } from "@/modules/whiteboards/server/config.server";
import { pinMeetingWhiteboardSharedState } from "@/modules/whiteboards/server/document-revisions";
import { refreshBoardAuthority } from "@/modules/whiteboards/server/meeting/authority.server";
import { createEgressClient, createRoomServiceClient } from "@/platform/realtime/livekit-clients.server";
import { mediaNodes, type MediaNode } from "@/platform/realtime/nodes";
import { meetingRecordingsPrefix } from "@/platform/storage/r2-keys";
import { RECORDING_FILE_TEMPLATE } from "@/modules/meetings/contract/recording-file";
import { discardUnstartedMeeting } from "../lifecycle/lifecycle";
import { finalizeMeetingEnd } from "../lifecycle/finalize";
import { isSummaryGenerationConfigured } from "../history/summary-generation-policy";
import { startMeetingFollowUp, startMeetingWhiteboardCapture } from "../lifecycle/follow-up.server";
import { ROOM_COMPOSITE_EGRESS_PRESET } from "../media/egress-media-policy.server";
import { isLiveKitMissingError, zeroPermissionsAndRemoveParticipant } from "../media/livekit-removal";
import type { MeetingState, ParticipantGrant, Placement } from "./model";
import type { Effect, EffectSucceeded, ObservedEgress } from "./protocol";
import { spaceRoleFor } from "./client.server";

export interface EffectContext {
  env: Env;
  db: Database;
  /** The committed state that claimed the effect. */
  state: MeetingState;
}

/** Run one effect and describe its outcome as the input the core applies next. */
export async function executeEffect(
  effect: Effect,
  context: EffectContext,
): Promise<EffectSucceeded["result"]> {
  const { env, db, state } = context;
  const meetingId = state.meta.meetingId;
  const roomName = liveKitMeetingRoomName(meetingId);
  // The node the effect was planned for, not the one the meeting is on by the
  // time it runs: its result is fenced by that same placement.
  const node = (placement: Placement): MediaNode => {
    const found = mediaNodes(env).get(placement.nodeId);
    if (!found) throw new Error(`Meeting ${meetingId} has no configured media node ${placement.nodeId}`);
    return found;
  };

  switch (effect.kind) {
    case "livekit.grant": {
      try {
        await createRoomServiceClient(node(effect.placement)).updateParticipant(roomName, effect.identity, {
          attributes: effect.grant.attributes,
          permission: {
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
            canUpdateMetadata: false,
            canPublishSources: publishSources(effect.grant),
          },
        });
      } catch (error) {
        // Gone from the room: the presence check ends the attempt.
        if (!isLiveKitMissingError(error)) throw error;
      }
      return {
        kind: "grantApplied",
        placement: effect.placement,
        attemptId: effect.attemptId,
        sid: effect.sid,
        hash: effect.hash,
      };
    }

    case "livekit.remove":
      await zeroPermissionsAndRemoveParticipant(
        createRoomServiceClient(node(effect.placement)),
        roomName,
        effect.identity,
        "[coordinator]",
      );
      return { kind: "removed", placement: effect.placement, identity: effect.identity };

    case "livekit.listParticipants": {
      const listed = { kind: "participantsListed", placement: effect.placement, requestedAt: effect.requestedAt } as const;
      try {
        const participants = await createRoomServiceClient(node(effect.placement)).listParticipants(roomName);
        return {
          ...listed,
          roomExists: true,
          participants: participants.map((participant) => ({
            identity: participant.identity,
            sid: participant.sid,
            joinedAt: sessionJoinedAt(participant),
            standard: participant.kind === STANDARD_PARTICIPANT,
          })),
        };
      } catch (error) {
        if (!isLiveKitMissingError(error)) throw error;
        return { ...listed, roomExists: false, participants: [] };
      }
    }

    case "space.authority": {
      const meeting = {
        spaceId: state.meta.spaceId,
        spaceKind: state.meta.spaceKind,
        startedByUserId: state.meta.startedByUserId,
      };
      return {
        kind: "authorityChecked",
        requestedAt: effect.requestedAt,
        roles: await Promise.all(effect.userIds.map(async (userId) => ({
          userId,
          spaceRole: await spaceRoleFor(db, meeting, userId),
        }))),
      };
    }

    case "livekit.roomMetadata":
      await createRoomServiceClient(node(effect.placement)).updateRoomMetadata(roomName, JSON.stringify(effect.metadata));
      return { kind: "metadataApplied", placement: effect.placement, room: effect.room, version: effect.version };

    case "livekit.startEgress":
      return startEgress(env, db, node(effect.placement), meetingId, effect);

    case "livekit.listEgress": {
      const egresses = await createEgressClient(node(effect.placement)).listEgress({ roomName });
      return {
        kind: "egressObserved",
        placement: effect.placement,
        complete: true,
        egresses: egresses.map(observeEgressInfo),
      };
    }

    case "livekit.stopEgress":
      try {
        await createEgressClient(node(effect.placement)).stopEgress(effect.egressId);
        return { kind: "egressStopped", placement: effect.placement, egressId: effect.egressId, missing: false };
      } catch (error) {
        if (!isLiveKitMissingError(error)) throw error;
        return { kind: "egressStopped", placement: effect.placement, egressId: effect.egressId, missing: true };
      }

    case "livekit.deleteRoom":
      try {
        await createRoomServiceClient(node(effect.placement)).deleteRoom(roomName);
      } catch (error) {
        if (!isLiveKitMissingError(error)) throw error;
      }
      return { kind: "roomDeleted", placement: effect.placement };

    case "meeting.finalize":
      await finalizeMeetingEnd(db, {
        meetingId,
        reason: effect.reason,
        now: new Date(state.meta.endedAt ?? Date.now()),
        summaryOwed: isSummaryGenerationConfigured(env),
      });
      return { kind: "finalized" };

    case "meeting.postTasks":
      // Durable from here on: each job keeps its own progress and retries.
      await startMeetingFollowUp(env, meetingId);
      return { kind: "postTasksDone" };

    case "whiteboard.capture":
      await startMeetingWhiteboardCapture(env, meetingId);
      return { kind: "whiteboardCaptureStarted" };

    case "whiteboard.pin":
      // Without a sync server there is nothing to pin; the capture records why.
      if (isWhiteboardConfigured(env)) {
        await pinMeetingWhiteboardSharedState(db, env, {
          meetingId: effect.meetingId,
          usageId: effect.pin.usageId,
          commandId: effect.pin.commandId,
          startBefore: effect.pin.startBefore,
        });
      }
      return { kind: "whiteboardPinned", usageId: effect.pin.usageId, commandId: effect.pin.commandId };

    case "whiteboard.authority":
      await refreshBoardAuthority(env, effect.syncRoomId, effect.narrowed ? effect.principalKey : undefined);
      return { kind: "whiteboardAuthorityApplied", admissionId: effect.admissionId, hash: effect.hash };

    case "meeting.discard":
      await discardUnstartedMeeting(db, meetingId);
      return { kind: "finalized" };

    case "meeting.drain":
      await db
        .update(meetings)
        .set({ drainedAt: new Date() })
        .where(eq(meetings.id, meetingId));
      return { kind: "drained" };
  }
}

/** What a participant may publish under `grant`; its join token carries the same. */
export function publishSources(grant: ParticipantGrant): TrackSource[] {
  const sources = [TrackSource.CAMERA, TrackSource.MICROPHONE];
  if (grant.canScreenShare) sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  return sources;
}

/** What a participant may publish: screen share only for moderators or on a grant. */
export function publishSourcesFor(role: MeetingRole, screenShareGranted: boolean): TrackSource[] {
  return publishSources({ role, canScreenShare: role !== "attendee" || screenShareGranted, attributes: {} });
}

async function startEgress(
  env: Env,
  db: Database,
  node: MediaNode,
  meetingId: string,
  effect: Extract<Effect, { kind: "livekit.startEgress" }>,
): Promise<EffectSucceeded["result"]> {
  const roomName = liveKitMeetingRoomName(meetingId);
  const output = effect.mode === "recording"
    ? new EncodedFileOutput({
        fileType: EncodedFileType.MP4,
        filepath: `${meetingRecordingsPrefix(meetingId)}${RECORDING_FILE_TEMPLATE}`,
      })
    : new StreamOutput({ protocol: StreamProtocol.RTMP, urls: [effect.target ?? ""] });
  const [link] = await db
    .select({ code: meetingLinks.code })
    .from(meetings)
    .innerJoin(meetingLinks, eq(meetingLinks.id, meetings.meetingLinkId))
    .where(eq(meetings.id, meetingId))
    .limit(1);
  const customBaseUrl = await getWhiteboardRecorderCustomBaseUrl(env, meetingId, {
    egressMode: effect.mode,
    meetingCode: link?.code ?? null,
  });
  try {
    const info = await createEgressClient(node).startRoomCompositeEgress(roomName, output, {
      layout: "",
      encodingOptions: ROOM_COMPOSITE_EGRESS_PRESET,
      ...(customBaseUrl && { customBaseUrl }),
    });
    return { kind: "egressStartResult", placement: effect.placement, opId: effect.opId, egressId: info.egressId, error: null };
  } catch (error) {
    // A refusal the provider answered is final. Anything else (a timeout, a
    // lost response) may have created an egress, so it is left to the room
    // lookup that the unanswered op triggers.
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const message = error instanceof Error ? redactRtmpUrl(error.message) : "";
      return {
        kind: "egressStartResult",
        placement: effect.placement,
        opId: effect.opId,
        egressId: null,
        error: message ? `LiveKit egress did not start: ${message}` : "LiveKit egress did not start.",
      };
    }
    throw error;
  }
}

/**
 * When LiveKit says a participant's current session joined the room, in
 * milliseconds (`joinedAtMs`, else `joinedAt` in seconds), or null when the
 * server did not say: each reconnect is a new session with a later time.
 */
export function sessionJoinedAt(info: Pick<ParticipantInfo, "joinedAt" | "joinedAtMs">): number | null {
  const ms = Number(info.joinedAtMs ?? 0n);
  if (Number.isSafeInteger(ms) && ms > 0) return ms;
  const seconds = Number(info.joinedAt ?? 0n);
  return Number.isSafeInteger(seconds * 1000) && seconds > 0 ? seconds * 1000 : null;
}

/** `ParticipantInfo.Kind.STANDARD`: an app participant, not an agent or recorder. */
const STANDARD_PARTICIPANT = 0;
const STREAM_ACTIVE = 0;
const STREAM_FAILED = 2;

export function observeEgressInfo(info: EgressInfo): ObservedEgress {
  const failedStream = info.streamResults.find((stream) => stream.status === STREAM_FAILED);
  return {
    egressId: info.egressId,
    status: egressStatus(info.status),
    streamActive: info.streamResults.some((stream) => stream.status === STREAM_ACTIVE),
    streamFailure: failedStream
      ? failedStream.error ? redactRtmpUrl(failedStream.error) : "The streaming destination rejected the stream."
      : null,
    error: info.error ? redactRtmpUrl(info.error) : null,
  };
}

function egressStatus(status: EgressStatus): ObservedEgress["status"] {
  switch (status) {
    case EgressStatus.EGRESS_STARTING:
      return "starting";
    case EgressStatus.EGRESS_ACTIVE:
      return "active";
    case EgressStatus.EGRESS_ENDING:
      return "ending";
    case EgressStatus.EGRESS_COMPLETE:
      return "complete";
    default:
      return "failed";
  }
}

function redactRtmpUrl(value: string): string {
  return value.replace(/rtmps?:\/\/\S+/gi, "[redacted RTMP URL]");
}

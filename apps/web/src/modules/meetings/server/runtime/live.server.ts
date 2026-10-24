import "@tanstack/react-start/server-only";
import type * as v from "valibot";
import type { Database } from "@orbmeet/db";
import { Errors } from "@/lib/app-errors";
import type { AuthFnContext, RequestFnContext } from "@/app/bootstrap/middleware";
import { resolveMeetingEntitlement } from "@/modules/billing/server/entitlements.server";
import type {
  decideAdmissionSchema,
  decideScreenShareSchema,
  endMeetingSchema,
  listPendingAdmissionsSchema,
  ownConnectionSchema,
  participantDecisionSchema,
  requestBoardSchema,
  requestTranscriptionStopSchema,
  setTranscriptionSchema,
  setCountdownSchema,
  setMeetingJoinPolicySchema,
  setMeetingModeratorSchema,
  setRecordingSchema,
  setStreamingSchema,
} from "@/modules/meetings/contract/schemas";
import { clearWhiteboardMeetingCookies } from "@/modules/whiteboards/server/orchestration.server";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { buildRtmpUrl } from "../media/rtmp-destination.server";
import type { CoordinatorCommand, SubjectInput } from "./api";
import { callCoordinator, requestSubject } from "./client.server";
import type { EgressView, Reply } from "./protocol";

type Input<S extends v.GenericSchema> = v.InferOutput<S>;

async function meetingRow(db: Database, meetingId: string): Promise<{ id: string }> {
  const meeting = await db.query.meetings.findFirst({
    where: { id: meetingId },
    columns: { id: true },
  });
  if (!meeting) throw Errors.NOT_FOUND("Meeting");
  return meeting;
}

/**
 * Send one command for the requesting subject: the signed-in user, or the
 * guest whose cookie proves the admission behind `connectionId`.
 */
async function send(
  context: RequestFnContext,
  action: string,
  data: { meetingId: string; connectionId?: string },
  build: (subject: SubjectInput) => CoordinatorCommand,
): Promise<Reply> {
  const { env, db, user, clientIP } = context;
  await enforceRateLimit(env, `meeting:${action}:${user?.id ?? clientIP}`);
  const meeting = await meetingRow(db, data.meetingId);
  const subject = await requestSubject(db, meeting.id, user, { attemptId: data.connectionId ?? null });
  const reply = await callCoordinator(env, { kind: "command", meetingId: meeting.id, command: build(subject) });
  return reply;
}

function expect<K extends Reply["kind"]>(reply: Reply, kind: K): Extract<Reply, { kind: K }> {
  if (reply.kind !== kind) throw Errors.INTERNAL();
  return reply as Extract<Reply, { kind: K }>;
}

/** The egress fields a join reports, in the client's contract. */
export function egressFields(egress: EgressView) {
  return {
    recordingActive: egress.recordingActive,
    streamingActive: egress.streamingActive,
    activeEgressId: egress.mode === "recording" ? egress.egressId : null,
    activeStreamEgressId: egress.mode === "streaming" ? egress.egressId : null,
    egressStateRevision: egress.revision,
  };
}

// ─── Connection ──────────────────────────────────────────────────────────────

export async function leaveMeeting(data: Input<typeof ownConnectionSchema>, context: RequestFnContext) {
  const reply = expect(
    await send(context, "leave", data, (subject) => ({ kind: "leave", subject, attemptId: data.connectionId })),
    "left",
  );
  if (reply.found) await clearWhiteboardMeetingCookies(context.env, data.meetingId);
  return { success: true, found: reply.found };
}

/** Give back a connection the client will never use. It never ends a meeting. */
export async function releaseMeetingAccess(data: Input<typeof ownConnectionSchema>, context: RequestFnContext) {
  await send(context, "release", data, (subject) => ({ kind: "release", subject, attemptId: data.connectionId }));
  return { success: true };
}

export async function endMeeting(data: Input<typeof endMeetingSchema>, context: AuthFnContext) {
  await send(context, "end", data, (subject) => ({ kind: "end", subject, reason: "host" })).catch((error: unknown) => {
    // Ended meanwhile, by this request's retry or anyone: what was asked is done.
    if ((error as { code?: unknown } | null)?.code !== "MEETING_ENDED") throw error;
  });
  await clearWhiteboardMeetingCookies(context.env, data.meetingId);
  return { success: true };
}

// ─── Admissions and moderation ───────────────────────────────────────────────

export async function listPendingAdmissions(
  data: Input<typeof listPendingAdmissionsSchema>,
  context: RequestFnContext,
) {
  const reply = expect(
    await send(context, "admissions", data, (subject) => ({ kind: "listPending", subject })),
    "pending",
  );
  return {
    joinPolicy: reply.joinPolicy,
    pending: reply.pending.map((request) => ({
      id: request.id,
      displayName: request.displayName,
      userId: request.userId,
      role: "attendee" as const,
      joinedAt: new Date(request.createdAt).toISOString(),
    })),
  };
}

export async function decideAdmission(data: Input<typeof decideAdmissionSchema>, context: RequestFnContext) {
  await send(context, "admission-decision", data, (subject) => ({
    kind: "decideAdmission",
    subject,
    admissionId: data.admissionId,
    approve: data.approve,
  }));
  return { success: true };
}

export async function removeParticipant(data: Input<typeof participantDecisionSchema>, context: RequestFnContext) {
  const reply = expect(
    await send(context, "remove-participant", data, (subject) => ({
      kind: "removeParticipant",
      subject,
      admissionId: data.admissionId,
    })),
    "removed",
  );
  return { success: true, keptOut: reply.keptOut };
}

export async function setMeetingJoinPolicy(
  data: Input<typeof setMeetingJoinPolicySchema>,
  context: AuthFnContext,
) {
  const reply = expect(
    await send(context, "join-policy", data, (subject) => ({ kind: "setJoinPolicy", subject, joinPolicy: data.joinPolicy })),
    "joinPolicy",
  );
  return { success: true, joinPolicy: reply.joinPolicy };
}

export async function setMeetingModerator(
  data: Input<typeof setMeetingModeratorSchema>,
  context: AuthFnContext,
) {
  const reply = expect(
    await send(context, "moderator", data, (subject) => ({
      kind: "setModerator",
      subject,
      identity: data.targetParticipantIdentity,
      moderator: data.moderator,
    })),
    "role",
  );
  return { success: true, role: reply.role };
}

// ─── Hands, screen share, countdown ──────────────────────────────────────────

export async function raiseHand(data: Input<typeof ownConnectionSchema>, context: RequestFnContext) {
  await send(context, "hand", data, (subject) => ({
    kind: "raiseHand",
    subject,
    attemptId: data.connectionId,
    raiseId: crypto.randomUUID(),
  }));
  return { success: true };
}

export async function lowerHand(data: Input<typeof ownConnectionSchema>, context: RequestFnContext) {
  await send(context, "hand", data, (subject) => ({ kind: "lowerHand", subject, attemptId: data.connectionId }));
  return { success: true };
}

export async function resolveHandRaise(data: Input<typeof participantDecisionSchema>, context: RequestFnContext) {
  await send(context, "hand-decision", data, (subject) => ({
    kind: "resolveHand",
    subject,
    admissionId: data.admissionId,
  }));
  return { success: true };
}

export async function requestScreenShare(data: Input<typeof ownConnectionSchema>, context: RequestFnContext) {
  await send(context, "screen-share", data, (subject) => ({
    kind: "requestScreenShare",
    subject,
    attemptId: data.connectionId,
  }));
  return { success: true };
}

export async function stopScreenShare(data: Input<typeof ownConnectionSchema>, context: RequestFnContext) {
  await send(context, "screen-share", data, (subject) => ({
    kind: "stopScreenShare",
    subject,
    attemptId: data.connectionId,
  }));
  return { success: true };
}

export async function requestBoard(data: Input<typeof requestBoardSchema>, context: RequestFnContext) {
  await send(context, "board-request", data, (subject) => ({
    kind: "requestBoard",
    subject,
    attemptId: data.connectionId,
    requested: data.requested,
  }));
  return { success: true };
}

export async function declineBoardRequest(data: Input<typeof participantDecisionSchema>, context: RequestFnContext) {
  await send(context, "board-request-decision", data, (subject) => ({
    kind: "declineBoardRequest",
    subject,
    admissionId: data.admissionId,
  }));
  return { success: true };
}

export async function setTranscription(data: Input<typeof setTranscriptionSchema>, context: RequestFnContext) {
  const reply = expect(
    await send(context, "transcription", data, (subject) => ({ kind: "setTranscription", subject, on: data.on })),
    "transcription",
  );
  return { success: true, on: reply.on };
}

export async function requestTranscriptionStop(
  data: Input<typeof requestTranscriptionStopSchema>,
  context: RequestFnContext,
) {
  await send(context, "transcription-request", data, (subject) => ({
    kind: "requestTranscriptionStop",
    subject,
    attemptId: data.connectionId,
    requested: data.requested,
  }));
  return { success: true };
}

export async function declineTranscriptionStop(
  data: Input<typeof participantDecisionSchema>,
  context: RequestFnContext,
) {
  await send(context, "transcription-request-decision", data, (subject) => ({
    kind: "declineTranscriptionStop",
    subject,
    admissionId: data.admissionId,
  }));
  return { success: true };
}

export async function decideScreenShare(data: Input<typeof decideScreenShareSchema>, context: RequestFnContext) {
  await send(context, "screen-share-decision", data, (subject) => ({
    kind: "decideScreenShare",
    subject,
    admissionId: data.admissionId,
    allow: data.allow,
  }));
  return { success: true };
}

export async function setCountdown(data: Input<typeof setCountdownSchema>, context: RequestFnContext) {
  await send(context, "countdown", data, (subject) => ({ kind: "setCountdown", subject, endsAt: data.endsAtMs }));
  return { success: true };
}

// ─── Recording and streaming ─────────────────────────────────────────────────

async function assertEgressAllowed(db: Database, meetingId: string, mode: "recording" | "streaming") {
  const meeting = await db.query.meetings.findFirst({
    where: { id: meetingId },
    columns: {
      spaceId: true,
      startedByUserId: true,
      billingPrincipalType: true,
      billingPrincipalId: true,
      billingPlan: true,
    },
  });
  if (!meeting) throw Errors.NOT_FOUND("Meeting");
  const { limits } = await resolveMeetingEntitlement(db, meeting);
  if (mode === "recording" && !limits.recordingEnabled) {
    throw Errors.PLAN_LIMIT_REACHED("Recording is not available on your plan");
  }
  if (mode === "streaming" && !limits.streamingEnabled) {
    throw Errors.PLAN_LIMIT_REACHED("Streaming is not available on your plan");
  }
}

export async function setRecording(data: Input<typeof setRecordingSchema>, context: AuthFnContext) {
  if (data.on) await assertEgressAllowed(context.db, data.meetingId, "recording");
  const reply = expect(
    await send(context, "recording", data, (subject) => ({
      kind: "setEgress",
      subject,
      mode: "recording",
      on: data.on,
      target: null,
    })),
    "egress",
  );
  return reply.egress;
}

export async function setStreaming(data: Input<typeof setStreamingSchema>, context: AuthFnContext) {
  let target: string | null = null;
  if (data.on) {
    await assertEgressAllowed(context.db, data.meetingId, "streaming");
    const streamKey = data.streamKey?.trim();
    if (!data.platform || !streamKey) throw Errors.VALIDATION("Platform and stream key are required");
    target = await buildRtmpUrl(data.platform, streamKey);
  }
  const reply = expect(
    await send(context, "streaming", data, (subject) => ({
      kind: "setEgress",
      subject,
      mode: "streaming",
      on: data.on,
      target,
    })),
    "egress",
  );
  return reply.egress;
}


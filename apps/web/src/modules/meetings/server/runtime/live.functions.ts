/**
 * The RPCs of a live meeting. Every one is a single request to the meeting's
 * MeetingRoom (./meeting-room.ts); this file only declares them, so it
 * carries no server imports into client route graphs.
 */
import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import { authMiddleware, requestMiddleware } from "@/app/bootstrap/middleware";
import {
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
import * as live from "./live.server";

export const leaveMeeting = createServerFn({ method: "POST" })
  .validator(serverInput(ownConnectionSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.leaveMeeting(data, context));

export const releaseMeetingAccess = createServerFn({ method: "POST" })
  .validator(serverInput(ownConnectionSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.releaseMeetingAccess(data, context));

export const endMeeting = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(endMeetingSchema))
  .handler(({ data, context }) => live.endMeeting(data, context));

export const listPendingAdmissions = createServerFn({ method: "GET" })
  .validator(serverInput(listPendingAdmissionsSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.listPendingAdmissions(data, context));

export const decideAdmission = createServerFn({ method: "POST" })
  .validator(serverInput(decideAdmissionSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.decideAdmission(data, context));

export const removeParticipant = createServerFn({ method: "POST" })
  .validator(serverInput(participantDecisionSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.removeParticipant(data, context));

export const setMeetingJoinPolicy = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(setMeetingJoinPolicySchema))
  .handler(({ data, context }) => live.setMeetingJoinPolicy(data, context));

export const setMeetingModerator = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(setMeetingModeratorSchema))
  .handler(({ data, context }) => live.setMeetingModerator(data, context));

export const raiseHand = createServerFn({ method: "POST" })
  .validator(serverInput(ownConnectionSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.raiseHand(data, context));

export const lowerHand = createServerFn({ method: "POST" })
  .validator(serverInput(ownConnectionSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.lowerHand(data, context));

export const resolveHandRaise = createServerFn({ method: "POST" })
  .validator(serverInput(participantDecisionSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.resolveHandRaise(data, context));

export const requestScreenShare = createServerFn({ method: "POST" })
  .validator(serverInput(ownConnectionSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.requestScreenShare(data, context));

export const stopScreenShare = createServerFn({ method: "POST" })
  .validator(serverInput(ownConnectionSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.stopScreenShare(data, context));

export const requestBoard = createServerFn({ method: "POST" })
  .validator(serverInput(requestBoardSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.requestBoard(data, context));

export const declineBoardRequest = createServerFn({ method: "POST" })
  .validator(serverInput(participantDecisionSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.declineBoardRequest(data, context));

export const setTranscription = createServerFn({ method: "POST" })
  .validator(serverInput(setTranscriptionSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.setTranscription(data, context));

export const requestTranscriptionStop = createServerFn({ method: "POST" })
  .validator(serverInput(requestTranscriptionStopSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.requestTranscriptionStop(data, context));

export const declineTranscriptionStop = createServerFn({ method: "POST" })
  .validator(serverInput(participantDecisionSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.declineTranscriptionStop(data, context));

export const decideScreenShare = createServerFn({ method: "POST" })
  .validator(serverInput(decideScreenShareSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.decideScreenShare(data, context));

export const setCountdown = createServerFn({ method: "POST" })
  .validator(serverInput(setCountdownSchema))
  .middleware([requestMiddleware])
  .handler(({ data, context }) => live.setCountdown(data, context));

export const setRecording = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(setRecordingSchema))
  .handler(({ data, context }) => live.setRecording(data, context));

export const setStreaming = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(setStreamingSchema))
  .handler(({ data, context }) => live.setStreaming(data, context));

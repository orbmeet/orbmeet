/**
 * Server implementations behind the RPC declarations in this directory.
 * Split from the sibling RPC file so the declaration file carries no
 * DB/Drizzle imports and stays safe to include in client route graphs.
 */

import { meetings, meetingLinks, spaceDefaultMeetingLinks, spaces } from "@orbmeet/db/schema";
import { and, eq } from "drizzle-orm";
import type * as v from "valibot";
import { Errors, AppError } from "@/lib/app-errors";
import { sanitizeDisplayName } from "@/lib/sanitize";
import type { RequestFnContext } from "@/app/bootstrap/middleware";
import { resolveMeetingEntitlement } from "@/modules/billing/server/entitlements.server";
import { SCHEDULED_MEETING_EARLY_JOIN_MS } from "@/modules/meetings/contract/constants";
import { liveKitMeetingRoomName } from "@/modules/meetings/contract/livekit-room";
import { joinMeetingSchema } from "@/modules/meetings/contract/schemas";
import type { JoinMeetingResult, JoinResult } from "@/modules/meetings/contract/types";
import { findMeetingWhiteboardDocument } from "@/modules/whiteboards/server/documents";
import {
  buildWhiteboardJoinAccessExtras,
  whiteboardCapabilitiesForMeetingRole,
  whiteboardRoleForMeetingIdentity,
} from "@/modules/whiteboards/server/orchestration.server";
import { resolveWhiteboardCapabilities } from "@/modules/whiteboards/server/meeting/grants";
import { hashSessionToken, hmacSha256Hex } from "@/platform/crypto/tokens.server";
import { browserNodeLatencies, currentNodeLatencies } from "@/platform/realtime/node-latency.server";
import { getGuestCookieSecret, setGuestCookie } from "../access/guest-cookie.server";
import { guestNetworkKey } from "../access/guest-network.server";
import type { SubjectInput } from "../runtime/api";
import { callCoordinator, userSubject } from "../runtime/client.server";
import { egressFields } from "../runtime/live.server";
import { acquireMeetingOccurrence } from "./meeting-occurrence";
import { appErrorToJoinMeetingResult, endedOccurrenceJoinError, waitingForApproval } from "./join-results";

function joined(result: JoinResult): JoinMeetingResult {
  return { state: "joined", result };
}

/**
 * The secret a guest's first join brings. Every request of one first join
 * names the same key, so each derives the same secret, and the coordinator
 * answers a retry with the admission the first request created. Without a
 * key (a client from before keys) every request is a join of its own.
 */
async function newGuestSecret(authSecret: string, meetingId: string, firstJoinKey: string | undefined) {
  return firstJoinKey
    ? hmacSha256Hex(authSecret, `meeting-guest-first-join:${meetingId}:${firstJoinKey}`)
    : crypto.randomUUID();
}

/** Join through a meeting link and return LiveKit access for its open meeting. */
export async function joinMeetingImpl({
  data,
  context: { env, db, user, clientIP },
}: {
  data: v.InferOutput<typeof joinMeetingSchema>;
  context: RequestFnContext;
}) {
  try {
    const initialRow = await db
      .select({
        meetingLink: {
          id: meetingLinks.id,
          reusePolicy: meetingLinks.reusePolicy,
          spaceId: meetingLinks.spaceId,
          title: meetingLinks.title,
          allowGuests: meetingLinks.allowGuests,
          joinPolicy: meetingLinks.joinPolicy,
          expiresAt: meetingLinks.expiresAt,
          archivedAt: meetingLinks.archivedAt,
        },
        defaultMeetingLinkId: spaceDefaultMeetingLinks.meetingLinkId,
        space: {
          kind: spaces.kind,
          name: spaces.name,
        },
        meeting: {
          id: meetings.id,
          title: meetings.title,
          startedByUserId: meetings.startedByUserId,
          spaceId: meetings.spaceId,
          spaceKind: meetings.spaceKind,
          allowGuests: meetings.allowGuests,
          recordingEnabled: meetings.recordingEnabled,
          joinPolicy: meetings.joinPolicy,
          startedAt: meetings.startedAt,
          activeEgressId: meetings.activeEgressId,
          activeStreamEgressId: meetings.activeStreamEgressId,
          egressStateRevision: meetings.egressStateRevision,
          billingPrincipalType: meetings.billingPrincipalType,
          billingPrincipalId: meetings.billingPrincipalId,
          billingPlan: meetings.billingPlan,
        },
      })
      .from(meetingLinks)
      .innerJoin(spaces, eq(spaces.id, meetingLinks.spaceId))
      .leftJoin(
        spaceDefaultMeetingLinks,
        and(
          eq(spaceDefaultMeetingLinks.meetingLinkId, meetingLinks.id),
          eq(spaceDefaultMeetingLinks.spaceId, meetingLinks.spaceId),
        ),
      )
      .leftJoin(
        meetings,
        and(
          eq(meetings.status, "open"),
          // A link owns its occurrence lineage. The Space's required
          // default link remains the one bookmarkable entry, while any
          // future dedicated links cannot converge on another Meeting.
          eq(meetings.meetingLinkId, meetingLinks.id),
        ),
      )
      .where(eq(meetingLinks.code, data.code))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const meetingLink = initialRow?.meetingLink;
    const isSpaceDefault = Boolean(initialRow?.defaultMeetingLinkId);
    // Only a dedicated one-time link is time-gated. Reusable links remain
    // usable for ad-hoc Meetings and claim a schedule only near its start.
    const schedule =
      meetingLink?.reusePolicy === "one_time"
        ? await db.query.meetingSchedules.findFirst({
            where: { meetingLinkId: meetingLink.id },
            columns: { startsAt: true, canceledAt: true },
          })
        : null;
    if (!meetingLink || meetingLink.archivedAt || schedule?.canceledAt) {
      throw Errors.NOT_FOUND("Meeting");
    }
    // A client finding its way back into a meeting it was in: once that
    // meeting is no longer the link's open one it is over, and the client is
    // told so rather than starting (or waiting for) the link's next meeting.
    if (data.resumeMeetingId && initialRow?.meeting?.id !== data.resumeMeetingId) {
      throw Errors.MEETING_ENDED();
    }
    const lookupTime = new Date();
    // An expired link is only dead while no occurrence is running. A meeting
    // that is already open must stay joinable — including reconnects after a
    // page reload — even when the link's expiry lapses mid-meeting.
    if (!initialRow?.meeting && meetingLink.expiresAt && meetingLink.expiresAt < lookupTime) {
      throw Errors.NOT_FOUND("Meeting meetingLink has expired");
    }
    if (
      !initialRow?.meeting &&
      schedule &&
      lookupTime.getTime() < schedule.startsAt.getTime() - SCHEDULED_MEETING_EARLY_JOIN_MS
    ) {
      throw Errors.MEETING_NOT_STARTED();
    }

    const entitlement = await resolveMeetingEntitlement(db, {
      spaceId: meetingLink.spaceId,
      billingPrincipalType: initialRow?.meeting?.billingPrincipalType ?? null,
      billingPrincipalId: initialRow?.meeting?.billingPrincipalId ?? null,
      billingPlan: initialRow?.meeting?.billingPlan ?? null,
    });

    const { meeting, createdMeetingId } = await acquireMeetingOccurrence(db, {
      meetingLink: { ...meetingLink, isSpaceDefault },
      existingMeeting: initialRow?.meeting ?? null,
      starter: user,
      entitlement,
    });
    // Everything about who may enter, and on what terms, is decided by the
    // meeting's coordinator. A guest's cookie is set only when the coordinator
    // created (or found again) the admission it protects.
    const guestSecret = user ? null : await newGuestSecret(env.AUTH_SECRET, meeting.id, data.firstJoinKey);
    const subject: SubjectInput = user
      ? userSubject(user.id)
      : {
          kind: "guest",
          admissionId: data.reconnectAdmissionId ?? null,
          secret: data.reconnectAdmissionId ? getGuestCookieSecret(data.reconnectAdmissionId) : null,
        };
    const reply = await callCoordinator(env, {
      kind: "join",
      meetingId: meeting.id,
      join: {
        subject,
        admissionId: data.reconnectAdmissionId ?? null,
        clientAttemptId: data.clientAttemptId,
        displayName: sanitizeDisplayName(user?.name ?? data.displayName ?? "Guest"),
        captionLanguage: data.captionLanguage ?? "",
        unreachableMediaUrl: data.unreachableMediaUrl ?? null,
        nodeLatencies: browserNodeLatencies(env, data.nodeLatencies) ?? await currentNodeLatencies(env),
        replacesAttemptId: data.replacesConnectionId ?? null,
        newGuestSecretHash: guestSecret ? await hashSessionToken(guestSecret) : null,
        guestNetworkKey: user ? null : await guestNetworkKey(env.AUTH_SECRET, meeting.id, clientIP),
      },
    }).catch((error: unknown) => {
      if (!(error instanceof AppError) || error.code !== "MEETING_ENDED") throw error;
      throw endedOccurrenceJoinError({
        startedNow: createdMeetingId !== null,
        reusableLink: meetingLink.reusePolicy === "reusable",
        resuming: Boolean(data.reconnectAdmissionId),
      });
    });
    if (reply.kind !== "waiting" && !("token" in reply)) throw Errors.INTERNAL();

    const cookieOptions = { appUrl: env.APP_URL, environment: env.ENVIRONMENT };
    if (reply.kind === "waiting") {
      if (guestSecret && reply.newGuestAdmission) setGuestCookie(reply.admissionId, guestSecret, cookieOptions);
      return waitingForApproval(reply.admissionId, meeting.id);
    }

    const { participant } = reply;
    if (guestSecret && reply.newGuestAdmission) setGuestCookie(participant.admissionId, guestSecret, cookieOptions);
    if (meetingLink.reusePolicy !== "one_time") {
      // Permanent meeting links are stable entrances with no rolling expiry.
      const renewedAt = new Date();
      await db
        .update(meetingLinks)
        .set({ lastUsedAt: renewedAt, expiresAt: null, updatedAt: renewedAt })
        .where(eq(meetingLinks.id, meetingLink.id));
    }

    const whiteboardDocument = await findMeetingWhiteboardDocument(db, meeting.id);
    const grantPrincipal = participant.userId
      ? { type: "user" as const, id: participant.userId }
      : { type: "guest_admission" as const, id: participant.admissionId };
    // An edit grant outlives a reconnect, so the join token must carry it like
    // every other mint does. A role-only token here disagreed with the room's
    // authority check, which answered "refresh" to every attempt it made.
    const { capabilities: participantCapabilities } = await resolveWhiteboardCapabilities(db, {
      meetingId: meeting.id,
      principal: grantPrincipal,
      base: whiteboardCapabilitiesForMeetingRole(participant.role),
    });
    const surface = await buildWhiteboardJoinAccessExtras(env, {
      meetingId: meeting.id,
      mediaNodeId: participant.nodeId,
      participantIdentity: participant.identity,
      participantName: participant.displayName,
      participantRole: whiteboardRoleForMeetingIdentity(participant.role, participant.identity),
      participantCapabilities,
      grantPrincipal,
      connectionId: participant.attemptId,
      whiteboardDocument: whiteboardDocument
        ? {
            whiteboardId: whiteboardDocument.whiteboardId,
            syncRoomId: whiteboardDocument.syncRoomId,
            title: whiteboardDocument.title,
            surfaceOpen: whiteboardDocument.status === "active" && whiteboardDocument.surfaceOpen,
          }
        : undefined,
    });

    const result: JoinResult = {
      token: reply.token,
      serverUrl: reply.serverUrl,
      roomName: liveKitMeetingRoomName(meeting.id),
      meetingId: meeting.id,
      meetingStartedAtMs: participant.meetingStartedAt,
      serverNowMs: Date.now(),
      connectionId: participant.attemptId,
      admissionId: participant.admissionId,
      participantRole: participant.role,
      canModerate: participant.canModerate,
      canManageMeeting: participant.canManageMeeting,
      participantName: participant.displayName,
      participantIdentity: participant.identity,
      meetingTitle: meeting.title,
      // Only a shared Space is named. Every link lives in a Space, and a
      // personal one is named after its owner, so reporting it made every
      // personal call look like a Space meeting — the lookup already draws
      // this line, and the join now agrees with it.
      ...(initialRow?.space?.kind === "shared" && initialRow.space.name
        ? { spaceName: initialRow.space.name }
        : {}),
      joinPolicy: participant.joinPolicy,
      transcription: participant.room.transcription,
      expiresIn: reply.expiresIn,
      recordingEnabled: participant.recordingEnabled,
      ...egressFields(participant.egress),
      ...surface,
    };
    return joined(result);
  } catch (err) {
    if (err instanceof AppError) return appErrorToJoinMeetingResult(err);
    throw err;
  }
}

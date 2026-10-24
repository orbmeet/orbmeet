import type { Database } from "@orbmeet/db";
import {
  meetingAdmissions,
  meetingArtifacts,
  meetings,
  spaces,
} from "@orbmeet/db/schema";
import { and, desc, eq, exists, gte, lt, or, sql } from "drizzle-orm";
import { AppError, Errors } from "@/lib/app-errors";
import type {
  AutomationMeetingContent,
  AutomationMeetingLookup,
} from "@orbmeet/public-api-contract";

import { d1UnicodeContains } from "@/platform/database/d1-unicode-like";
import {
  bucketParticipantNames,
  selectParticipantDisplayNames,
} from "@/modules/meetings/server/history/meeting-list-enrichment";
import {
  canAccessMeetingHistory,
  meetingHistoryAccessPredicate,
} from "@/modules/meetings/server/access/resource-access";
import { summaryMatchesTranscriptSnapshot, type TranscriptSnapshot } from "@/modules/transcripts/server/generate-summary.server";
import { listTranscriptRowsPage } from "@/modules/transcripts/server/query";
import { buildAttachmentContentDisposition } from "@/modules/assets/server/content-disposition";
import { utcBoundsForLocalDate } from "@/lib/local-date-bounds";
import { buildR2Client } from "@/modules/assets/server/r2-client.server";

const MAX_SELECTOR_CANDIDATES = 51;

export async function resolveAutomationMeeting(
  db: Database,
  userId: string,
  lookup: AutomationMeetingLookup,
) {
  const bounds = !lookup.meetingId && lookup.date && lookup.timeZone
    ? utcBoundsForLocalDate(lookup.date, lookup.timeZone)
    : null;
  const titleQuery = !lookup.meetingId && lookup.title ? lookup.title : null;
  const spaceQuery = !lookup.meetingId && lookup.space ? lookup.space : null;
  const participantQuery = !lookup.meetingId && lookup.participant ? lookup.participant : null;

  const rows = await db
    .select({
      id: meetings.id,
      title: meetings.title,
      startedAt: meetings.startedAt,
      endedAt: meetings.endedAt,
      retainUntil: meetings.retainUntil,
      startedByUserId: meetings.startedByUserId,
      spaceId: meetings.spaceId,
      // The personal space is not addressable as a space in client payloads.
      spaceName: sql<string | null>`case when ${spaces.kind} = 'shared' then ${spaces.name} end`,
      transcriptSegmentCount: meetings.transcriptSegmentCount,
      transcriptLastIngestedAt: meetings.transcriptLastIngestedAt,
    })
    .from(meetings)
    .leftJoin(spaces, eq(spaces.id, meetings.spaceId))
    .where(and(
      eq(meetings.status, "ended"),
      lookup.meetingId ? eq(meetings.id, lookup.meetingId) : undefined,
      meetingHistoryAccessPredicate(db, userId),
      bounds ? gte(meetings.startedAt, bounds.earliest) : undefined,
      bounds ? lt(meetings.startedAt, bounds.latest) : undefined,
      titleQuery ? d1UnicodeContains(meetings.title, titleQuery) : undefined,
      spaceQuery ? d1UnicodeContains(spaces.name, spaceQuery) : undefined,
      participantQuery
        ? exists(
            db.select({ id: meetingAdmissions.id })
              .from(meetingAdmissions)
              .where(and(
                eq(meetingAdmissions.meetingId, meetings.id),
                eq(meetingAdmissions.admissionStatus, "approved"),
                d1UnicodeContains(meetingAdmissions.displayName, participantQuery),
              )),
          )
        : undefined,
    ))
    .orderBy(desc(meetings.startedAt), desc(meetings.id))
    .limit(lookup.meetingId ? 1 : MAX_SELECTOR_CANDIDATES);

  const selectorWindowSaturated = !lookup.meetingId
    && rows.length === MAX_SELECTOR_CANDIDATES;
  const participantRows = await selectParticipantDisplayNames(
    db,
    rows.map((meeting) => meeting.id),
  );
  const participantsByMeeting = bucketParticipantNames(participantRows, 6);
  const candidates = rows.map((meeting) => ({
    ...meeting,
    participantNames: participantsByMeeting.get(meeting.id) ?? [],
  }));

  if (candidates.length === 0 && !selectorWindowSaturated) {
    throw new AppError(
      "MEETING_NOT_FOUND",
      "No accessible ended Meeting matches those details",
      404,
      { selector: lookup.meetingId ? undefined : lookup },
    );
  }
  if (!lookup.meetingId && (candidates.length > 1 || selectorWindowSaturated)) {
    throw new AppError(
      "AMBIGUOUS_MEETING",
      selectorWindowSaturated
        ? "Too many ended Meetings match those details; add another detail to narrow the search"
        : "More than one ended Meeting matches those details",
      409,
      {
        selector: lookup,
        candidates: candidates.slice(0, 10).map((candidate) => ({
          title: candidate.title,
          startedAt: candidate.startedAt.toISOString(),
          endedAt: candidate.endedAt?.toISOString() ?? null,
          spaceName: candidate.spaceName,
          participants: candidate.participantNames,
        })),
        moreCandidates: selectorWindowSaturated || candidates.length > 10,
      },
    );
  }
  return candidates[0];
}

type DownloadableArtifact = {
  id: string;
  type: "recording" | "whiteboard_pdf";
  r2Key: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedByUserId: string | null;
  createdAt: Date;
};

async function signArtifactDownload(env: Env, artifact: DownloadableArtifact): Promise<string> {
  if (!env.R2_BUCKET_NAME) throw Errors.CONFIG_ERROR("Storage not configured");
  const { r2, endpoint } = buildR2Client(env);
  const url = new URL(`/${env.R2_BUCKET_NAME}/${artifact.r2Key}`, endpoint);
  url.searchParams.set("X-Amz-Expires", "300");
  url.searchParams.set(
    "response-content-disposition",
    buildAttachmentContentDisposition(artifact.filename),
  );
  const signed = await r2.sign(new Request(url.toString()), { aws: { signQuery: true } });
  return signed.url;
}

function included(content: AutomationMeetingContent[], value: AutomationMeetingContent): boolean {
  return content.includes(value);
}

export async function retrieveAutomationMeeting(
  db: Database,
  env: Env,
  userId: string,
  lookup: AutomationMeetingLookup,
) {
  const meeting = await resolveAutomationMeeting(db, userId, lookup);
  if (!await canAccessMeetingHistory(db, meeting.id, userId)) throw Errors.FORBIDDEN();

  const [summaryRow, artifactRows] = await Promise.all([
    db.query.meetingSummaries.findFirst({
      where: { meetingId: meeting.id },
      orderBy: (table) => [desc(table.createdAt)],
    }),
    db
      .select({
        id: meetingArtifacts.id,
        type: meetingArtifacts.type,
        r2Key: meetingArtifacts.r2Key,
        filename: meetingArtifacts.filename,
        mimeType: meetingArtifacts.mimeType,
        size: meetingArtifacts.size,
        uploadedByUserId: meetingArtifacts.uploadedByUserId,
        createdAt: meetingArtifacts.createdAt,
      })
      .from(meetingArtifacts)
      .where(and(
        eq(meetingArtifacts.meetingId, meeting.id),
        or(eq(meetingArtifacts.type, "recording"), eq(meetingArtifacts.type, "whiteboard_pdf")),
      ))
      .orderBy(desc(meetingArtifacts.createdAt), desc(meetingArtifacts.id)),
  ]);

  const snapshot: TranscriptSnapshot = {
    segmentCount: meeting.transcriptSegmentCount,
    lastUpdatedAt: meeting.transcriptLastIngestedAt,
  };
  const summary = summaryRow && summaryMatchesTranscriptSnapshot(summaryRow, snapshot)
      ? {
        summary: summaryRow.summary,
        durationSeconds: summaryRow.durationSeconds,
        participantCount: summaryRow.participantCount,
        createdAt: summaryRow.createdAt.toISOString(),
      }
    : null;
  const accessibleRecordings = artifactRows.filter((artifact): artifact is DownloadableArtifact =>
    artifact.type === "recording");
  const whiteboardPdf = artifactRows.find((artifact): artifact is DownloadableArtifact =>
    artifact.type === "whiteboard_pdf") ?? null;

  const response: Record<string, unknown> = {
    meeting: {
      id: meeting.id,
      title: meeting.title,
      startedAt: meeting.startedAt.toISOString(),
      endedAt: meeting.endedAt?.toISOString() ?? null,
      retainUntil: meeting.retainUntil?.toISOString() ?? null,
      spaceName: meeting.spaceName,
      participants: meeting.participantNames,
    },
    available: {
      summary: Boolean(summary),
      transcript: snapshot.segmentCount > 0,
      recordings: accessibleRecordings.length > 0,
      whiteboardPdf: Boolean(whiteboardPdf),
    },
  };

  if (included(lookup.include, "summary")) response.summary = summary;
  if (included(lookup.include, "transcript")) {
    const page = await listTranscriptRowsPage(db, meeting.id, {
      cursor: lookup.transcriptCursor ?? null,
      limit: lookup.transcriptLimit,
    });
    response.transcript = {
      segments: page.transcripts.map((segment) => ({
        ...segment,
        startedAt: segment.startedAt.toISOString(),
        updatedAt: segment.updatedAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }
  if (included(lookup.include, "recordings")) {
    response.recordings = await Promise.all(accessibleRecordings.map(async (artifact) => ({
      id: artifact.id,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      size: artifact.size,
      createdAt: artifact.createdAt.toISOString(),
      downloadUrl: await signArtifactDownload(env, artifact),
    })));
  }
  if (included(lookup.include, "whiteboard_pdf")) {
    response.whiteboardPdf = whiteboardPdf
      ? {
          id: whiteboardPdf.id,
          filename: whiteboardPdf.filename,
          mimeType: whiteboardPdf.mimeType,
          size: whiteboardPdf.size,
          createdAt: whiteboardPdf.createdAt.toISOString(),
          downloadUrl: await signArtifactDownload(env, whiteboardPdf),
        }
      : null;
  }

  return response;
}

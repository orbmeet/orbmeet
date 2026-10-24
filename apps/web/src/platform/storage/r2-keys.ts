// The single source of every R2 object key. The
// top-level prefix encodes the retention class so bucket lifecycle rules are
// prefix rules:
//
//   staging/{scope}/{uploadId}                              expires via lifecycle rule
//   intents/promotions/{finalKey}                           expires via lifecycle rule
//   spaces/{spaceId}/uploads/{assetId}.{ext}                user files
//   meetings/{meetingId}/recordings/{egressId}.{ext}        user output
//   meetings/{meetingId}/exports/whiteboard/{publishId}.pdf Meeting handout
//   whiteboards/{whiteboardId}/assets/{assetId}             document assets
//   whiteboards/{whiteboardId}/revisions/{revisionId}.json  immutable history
//   internal/meetings/{meetingId}/recorder/{name}           recorder snapshots
//   internal/meetings/{meetingId}/canvases/{whiteboardId}/{captureId}.json (frozen storage v1)
//                                                            last shared state
//   internal/whiteboard-backups/{run}/{room}.db            room database backups (sync server)
//   internal/whiteboards/{whiteboardId}/state/              retired: a board is its room database on the sync node
//
// Call sites never concatenate keys; they call a builder here. Purge paths
// delete by the per-entity prefixes so no object survives its owner. The D1
// CHECK constraints pin the same prefixes with substr() — change either only
// together with the other.

import type { MEETING_ARTIFACT_TYPES } from "@orbmeet/domain-model";

/** Ids and key segments must not introduce path structure or wildcards. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function segment(value: string, label: string): string {
  if (value === "." || value === ".." || !SAFE_SEGMENT.test(value)) {
    throw new Error(`invalid R2 key segment for ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

// --- staging (lifecycle-expired upload intents) -----------------------------

const STAGING_PREFIX = "staging/";

export function stagingKey(scope: string, uploadId: string): string {
  return `${STAGING_PREFIX}${segment(scope, "scope")}/${segment(uploadId, "uploadId")}`;
}

export function stagingWhiteboardPdfKey(meetingId: string, uploadId: string): string {
  return stagingKey(
    `meeting-${segment(meetingId, "meetingId")}-whiteboard-pdf`,
    `${segment(uploadId, "uploadId")}.pdf`,
  );
}

export function stagingSpacePdfKey(spaceId: string, assetId: string): string {
  return stagingKey(
    `space-${segment(spaceId, "spaceId")}-pdf`,
    `${segment(assetId, "assetId")}.pdf`,
  );
}

// --- promotion intents (lifecycle-expired reconciliation markers) -----------

/**
 * Durable reconciliation markers for immutable uploads. The guarded final key
 * is the marker key's suffix, so a listing names every possibly-unregistered
 * object without reading a single body. Like `staging/`, the prefix has a
 * bucket lifecycle rule, so even markers that outlive every sweep cannot
 * accumulate forever.
 */
export const PROMOTION_INTENTS_PREFIX = "intents/promotions/";

export function promotionIntentMarkerKey(finalKey: string): string {
  return `${PROMOTION_INTENTS_PREFIX}${finalKey}`;
}

export function finalKeyFromPromotionIntentMarker(markerKey: string): string | null {
  if (!markerKey.startsWith(PROMOTION_INTENTS_PREFIX)) return null;
  return markerKey.slice(PROMOTION_INTENTS_PREFIX.length);
}

// --- space files ------------------------------------------------------------

function spaceUploadsPrefix(spaceId: string): string {
  return `spaces/${segment(spaceId, "spaceId")}/uploads/`;
}

export function spaceUploadKey(spaceId: string, assetId: string, extension: string): string {
  return `${spaceUploadsPrefix(spaceId)}${segment(assetId, "assetId")}.${segment(extension, "extension")}`;
}

/** Everything a space owns directly (its meetings/whiteboards purge separately). */
export function spacePrefix(spaceId: string): string {
  return `spaces/${segment(spaceId, "spaceId")}/`;
}

// --- meeting outputs --------------------------------------------------------

export function meetingRecordingsPrefix(meetingId: string): string {
  return `meetings/${segment(meetingId, "meetingId")}/recordings/`;
}

/** The meeting a recording's key belongs to, or null for any other key. */
export function meetingIdOfRecordingKey(r2Key: string): string | null {
  const [root, meetingId, kind, name, ...rest] = r2Key.split("/");
  if (root !== "meetings" || kind !== "recordings" || rest.length > 0) return null;
  const safe = (value: string | undefined): value is string =>
    value !== undefined && value !== "." && value !== ".." && SAFE_SEGMENT.test(value);
  return safe(meetingId) && safe(name) ? meetingId : null;
}

function meetingWhiteboardHandoutsPrefix(meetingId: string): string {
  return `${meetingPrefix(meetingId)}exports/whiteboard/`;
}

export function meetingWhiteboardHandoutKey(meetingId: string, publishId: string): string {
  return `${meetingWhiteboardHandoutsPrefix(meetingId)}${segment(publishId, "publishId")}.pdf`;
}

function isMeetingWhiteboardHandoutKey(meetingId: string, r2Key: string): boolean {
  // Preserve access to handouts registered before versioned publication.
  if (r2Key === `${meetingPrefix(meetingId)}exports/whiteboard.pdf`) return true;
  const prefix = meetingWhiteboardHandoutsPrefix(meetingId);
  if (!r2Key.startsWith(prefix) || !r2Key.endsWith(".pdf")) return false;
  const publishId = r2Key.slice(prefix.length, -".pdf".length);
  return publishId.length > 0 && SAFE_SEGMENT.test(publishId);
}

/** User-output objects of one meeting. */
export function meetingPrefix(meetingId: string): string {
  return `meetings/${segment(meetingId, "meetingId")}/`;
}

// --- whiteboard documents ---------------------------------------------------
// Document keys are shared with the sync server (the only writer of their
// bytes), so they are defined once in whiteboard-core.

export {
  internalMeetingWhiteboardCaptureKey,
  whiteboardPrefix,
  whiteboardRevisionKey,
} from "@orbmeet/whiteboard-core/document-keys";

// --- internal state (Standard storage) --------------------------------------

/** Internal objects of one meeting (recorder snapshots, previews). */
export function internalMeetingPrefix(meetingId: string): string {
  return `internal/meetings/${segment(meetingId, "meetingId")}/`;
}

/** Internal objects of one whiteboard. */
export function internalWhiteboardPrefix(whiteboardId: string): string {
  return `internal/whiteboards/${segment(whiteboardId, "whiteboardId")}/`;
}

// --- artifact registration --------------------------------------------------

export type MeetingArtifactType = (typeof MEETING_ARTIFACT_TYPES)[number];

/**
 * Full-key validation for artifact registration writers, beyond the prefix
 * the D1 CHECK pins.
 */
export function isMeetingArtifactR2Key(
  type: MeetingArtifactType,
  ids: { meetingId: string },
  r2Key: string,
): boolean {
  switch (type) {
    case "recording":
      return r2Key.startsWith(meetingRecordingsPrefix(ids.meetingId));
    case "whiteboard_pdf":
      return isMeetingWhiteboardHandoutKey(ids.meetingId, r2Key);
  }
}

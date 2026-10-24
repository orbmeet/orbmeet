import type { ParsedPaddleEvent } from "@/modules/billing/server/paddle-subscription";
import type { PaidSubscriptionTier } from "@/modules/billing/contract/types";
import type { Job } from "@/platform/jobs/jobs";
import type { SyncCommandFailure } from "@orbmeet/whiteboard-core/sync-commands";
import type { MeetingWhiteboardDocument } from "@/modules/whiteboards/server/documents";
import type { DuplicateWhiteboardInput } from "@/modules/whiteboards/server/document-revisions";

/**
 * Work that must not overlap other work on the same thing, run one task at a
 * time per scope by a Durable Object (`SERIAL_SCOPES`, app/serial). The object
 * is the lock: a scope's tasks queue in it in arrival order, so nothing here
 * needs a lease, an expiry or a fence.
 *
 * A task's scope is derived from what it is about (`scopeOf`), so every change
 * to one Organization's paid seats, or to one Whiteboard's lifecycle, lands in
 * the same queue whoever starts it.
 * A task must never run another task in its own scope: it would wait on itself.
 */
export type SerialTask =
  /** Invite someone into a paid Organization, raising its seats if needed. */
  | {
      kind: "addOrganizationMember";
      organizationId: string;
      actorUserId: string;
      email: string;
      role: "admin" | "member";
    }
  /** Release a member's Organization seat. */
  | { kind: "removeOrganizationMember"; organizationId: string; actorUserId: string; memberUserId: string }
  /** Hand an Organization's billing to a new owner's subscription. */
  | {
      kind: "transferOrganizationOwnership";
      organizationId: string;
      currentOwnerUserId: string;
      newOwnerUserId: string;
      acceptedAt: number;
    }
  /** A Paddle subscription event for a subscription an Organization holds. */
  | { kind: "applyOrganizationPaddleEvent"; organizationId: string; event: ParsedPaddleEvent }
  /** Re-read an Organization owner's subscription from Paddle. */
  | {
      kind: "reconcileOrganizationOwner";
      organizationId: string;
      userId: string;
      subscriptionId: string;
      now: number;
    }
  /** Open (or reuse) a user's Paddle checkout for a plan. */
  | { kind: "preparePaddleCheckout"; userId: string; plan: PaidSubscriptionTier }
  /** Archive a Whiteboard: its room refuses writes first, then D1 records it. */
  | { kind: "archiveWhiteboard"; whiteboardId: string; actorUserId: string }
  /** Bring an archived Whiteboard back, within its Space's active-board limit. */
  | { kind: "restoreArchivedWhiteboard"; whiteboardId: string; actorUserId: string }
  /** Delete an archived, never-presented Whiteboard and start its purge. */
  | { kind: "deleteArchivedWhiteboard"; whiteboardId: string; actorUserId: string }
  /** Copy a Whiteboard (its current state or a revision), in the source's scope. */
  | ({ kind: "duplicateWhiteboard" } & DuplicateWhiteboardInput)
  /** The sync server half of a History restore; see whiteboards/server/restores.ts. */
  | {
      kind: "restoreWhiteboardContent";
      board: { id: string; spaceId: string; syncRoomId: string };
      job: Extract<Job, { kind: "restoreWhiteboard" }>;
    }
  /** Remove one board of a deleted Space, spending at most `r2Operations`. */
  | { kind: "purgeSpaceWhiteboard"; spaceId: string; whiteboardId: string; r2Operations: number }
  /** Create a Meeting's first Whiteboard unless it has one. */
  | {
      kind: "createFirstMeetingWhiteboard";
      meetingId: string;
      createdByUserId: string | null;
      clientTimeZone: string | null;
    }
  /** Promote and register an uploaded PDF as a Meeting's Whiteboard handout. */
  | { kind: "publishMeetingWhiteboardPdf"; meetingId: string; uploadId: string; fileSize: number; userId: string };

/** What each kind of task resolves. */
export interface SerialResults {
  addOrganizationMember: { success: true };
  removeOrganizationMember: { success: true; removed: boolean };
  transferOrganizationOwnership: boolean;
  applyOrganizationPaddleEvent: null;
  reconcileOrganizationOwner: null;
  preparePaddleCheckout:
    | { kind: "not_found" }
    | { kind: "subscription_exists" }
    | { kind: "pending" }
    | { kind: "transaction"; transactionId: string };
  archiveWhiteboard: { archivedAt: string };
  restoreArchivedWhiteboard: { restoredAt: string };
  deleteArchivedWhiteboard: { success: true };
  duplicateWhiteboard: { whiteboardId: string; title: string };
  restoreWhiteboardContent: { ok: true } | { ok: false; failure: Omit<SyncCommandFailure, "ok"> };
  purgeSpaceWhiteboard: { remainingOperations: number };
  createFirstMeetingWhiteboard: MeetingWhiteboardDocument | null;
  publishMeetingWhiteboardPdf:
    | { kind: "published"; r2Key: string }
    | { kind: "quota_exceeded" }
    | { kind: "invalid" };
}

export type SerialResult<T extends SerialTask> = SerialResults[T["kind"]];

/** The queue a task waits in. */
export function scopeOf(task: SerialTask): string {
  switch (task.kind) {
    case "addOrganizationMember":
    case "removeOrganizationMember":
    case "transferOrganizationOwnership":
    case "applyOrganizationPaddleEvent":
    case "reconcileOrganizationOwner":
      return `organization:${task.organizationId}`;
    case "preparePaddleCheckout":
      return `user:${task.userId}`;
    case "archiveWhiteboard":
    case "restoreArchivedWhiteboard":
    case "deleteArchivedWhiteboard":
    case "duplicateWhiteboard":
    case "purgeSpaceWhiteboard":
      return `whiteboard:${task.whiteboardId}`;
    case "restoreWhiteboardContent":
      return `whiteboard:${task.board.id}`;
    case "createFirstMeetingWhiteboard":
    case "publishMeetingWhiteboardPdf":
      return `meeting:${task.meetingId}`;
  }
}

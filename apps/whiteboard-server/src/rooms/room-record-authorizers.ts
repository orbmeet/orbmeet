import type { TLRecordAuthorizers } from "@tldraw/sync-core";
import { createUserId, type TLRecord, type TLShape, type TLUser } from "@tldraw/tlschema";
import { SHAPE_AUTHOR_META_KEY, shapeAuthorOf, withShapeAuthor } from "@orbmeet/whiteboard-core/shape-author";
import { canEditWhiteboardForMeta, isBaseManager } from "./room-authority.ts";
import { describeAssetSources, hasUnsafeUrl, isAllowedAsset, isPageFrameRecord } from "./record-rules.ts";
import type { SessionMeta } from "./room-types.ts";
import { logWarn } from "../lib/log.ts";

export interface RecordAuthorizerHost {
  /**
   * A session's metadata as the room holds it now. tldraw passes the meta a
   * session connected with, but a session's authority can narrow while it is
   * connected (`writesSuspended`), and that must count.
   */
  sessionMeta(sessionId: string): SessionMeta | undefined;
  /** False while the document refuses writes: archived, or mid-restore. */
  canAcceptMutations(): boolean;
  /** Whether `userId` drives the room's navigation now (see `RoomNavigation`). */
  isActiveNavigator(userId: string): boolean;
  roomLabel: string;
}

type Write<R> =
  | { type: "create"; prev: null; next: R }
  | { type: "update"; prev: R; next: R }
  | { type: "delete"; prev: R; next: null };


/**
 * The room's rules for what a client may write, record by record.
 *
 * tldraw runs these inside the commit, on each record after a patch is applied
 * and the record is migrated to the server's schema, and only for client
 * pushes. A refused write is skipped and the client rolls it back; the rest of
 * the push lands. On a create, the record returned is the one stored, which is
 * how identity fields are set: the client stamps its own for an immediate
 * label, and the room overwrites whatever it claimed.
 *
 * tldraw writes a record type with no authorizer straight through, so every
 * document record type the room's schema knows has one here (the room's tests
 * hold that), and every one of them first asks the same question: may this
 * session write the document at all, now? A viewer's writes never reach here
 * — tldraw skips them at the session's readonly flag — but an editor whose
 * authority the Worker has just narrowed is still a writable tldraw session
 * until its verdict lands, and an archived or restoring document refuses
 * everyone.
 */
export function roomRecordAuthorizers(host: RecordAuthorizerHost): TLRecordAuthorizers<TLRecord, SessionMeta> {
  const refuse = (sessionId: string, why: string): null => {
    logWarn(`[Room ${host.roomLabel}] Refused a write from session ${sessionId}: ${why}`);
    return null;
  };

  /**
   * The writer, when it may write this record at all: a session that may edit
   * now, in a document that accepts writes, leaving no url behind that
   * participants may not load.
   */
  const writer = (sessionId: string, write: Write<TLRecord>): SessionMeta | null => {
    const meta = host.sessionMeta(sessionId);
    if (!meta) return refuse(sessionId, "no session");
    if (!canEditWhiteboardForMeta(meta)) return refuse(sessionId, `a ${write.type} by a session that may not edit now`);
    if (!host.canAcceptMutations()) return refuse(sessionId, "a write while the document refuses writes");
    if (write.next && hasUnsafeUrl(write.next)) return refuse(sessionId, `an unsafe url on ${write.next.typeName}`);
    return meta;
  };

  return {
    // The document and its single page are made by the server; boards model
    // pages as page-frame shapes.
    document: ({ session }) => refuse(session.sessionId, "a write to the document record"),
    page: ({ session }) => refuse(session.sessionId, "a write to a native page record"),

    binding: ({ session, ...write }) => (writer(session.sessionId, write) ? write.next ?? write.prev : null),

    asset: ({ session, ...write }) => {
      if (!writer(session.sessionId, write)) return null;
      if (write.next === null) return write.prev;
      const documentId = host.sessionMeta(session.sessionId)?.documentId;
      if (!isAllowedAsset(write.next, documentId)) {
        return refuse(session.sessionId, `an asset loading what it may not (${describeAssetSources(write.next, documentId)})`);
      }
      return write.next;
    },

    shape: ({ session, ...write }) => {
      const meta = writer(session.sessionId, write);
      if (!meta) return null;

      // Which rules apply follows from a shape's type, so it never changes in
      // place: an editor could otherwise turn a shape into a page frame.
      if (write.type === "update" && write.prev.type !== write.next.type) {
        return refuse(session.sessionId, `a shape changing type (${write.prev.type} -> ${write.next.type})`);
      }
      if ((isPageFrameRecord(write.prev) || isPageFrameRecord(write.next)) && !isBaseManager(meta)) {
        return refuse(session.sessionId, "a page-frame write by a non-manager");
      }

      switch (write.type) {
        case "create":
          return stampNoteEditor(
            { ...write.next, meta: withShapeAuthor(write.next.meta, shapeAuthorOf(meta.userId, meta.userName)) },
            meta.userId,
          );
        case "update":
          // A shape keeps the author it was created with, or its lack of one.
          if (authorValue(write.prev) !== authorValue(write.next)) {
            return refuse(session.sessionId, "a change to a shape's author");
          }
          // A note names who last edited its text: whoever writes the change.
          if (!isOwnNoteEdit(write.prev, write.next, meta.userId)) {
            return refuse(session.sessionId, "a note's text credited to someone else");
          }
          return write.next;
        case "delete":
          return write.prev;
      }
    },

    // What tldraw shows of a user who is not on the board — the name on a note
    // they edited — comes from their `user:` record in the document. Each
    // session writes only its own, and only as the room knows it.
    user: ({ session, ...write }) => {
      const meta = writer(session.sessionId, write);
      if (!meta) return null;
      if (write.type === "delete") return refuse(session.sessionId, "a user record deleted");
      if (write.next.id !== createUserId(meta.userId)) return refuse(session.sessionId, "another user's record");
      if (write.next.imageUrl !== "") return refuse(session.sessionId, "a user record with an image");
      if (write.type === "create") return { ...write.next, name: meta.userName } satisfies TLUser;
      return write.next.name === meta.userName ? write.next : refuse(session.sessionId, "a user record renamed");
    },

    // Where the room is: written by whoever drives its navigation, as
    // themselves (see `RoomNavigationRecord`).
    orbmeet_navigation: ({ session, ...write }) => {
      const meta = writer(session.sessionId, write);
      if (!meta) return null;
      if (write.type === "delete") return refuse(session.sessionId, "the room's navigation deleted");
      if (!host.isActiveNavigator(meta.userId)) {
        return refuse(session.sessionId, "navigation written by someone who does not drive it");
      }
      if (write.next.presenterId !== meta.userId) {
        return refuse(session.sessionId, "navigation written in someone else's name");
      }
      return write.next;
    },
  };
}

function authorValue(shape: TLShape): string | undefined {
  const value = (shape.meta as Record<string, unknown>)[SHAPE_AUTHOR_META_KEY];
  return value === undefined ? undefined : JSON.stringify(value);
}

/** A new note credits its text to the session that made it, if to anyone. */
function stampNoteEditor(shape: TLShape, userId: string): TLShape {
  if (shape.type !== "note" || shape.props.textLastEditedBy === null) return shape;
  return { ...shape, props: { ...shape.props, textLastEditedBy: userId } };
}

/** Whether a note's text credit is left alone, cleared, or given to the writer — never to someone else. */
function isOwnNoteEdit(prev: TLShape, next: TLShape, userId: string): boolean {
  if (next.type !== "note" || prev.type !== "note") return true;
  const credit = next.props.textLastEditedBy;
  return credit === prev.props.textLastEditedBy || credit === null || credit === userId;
}

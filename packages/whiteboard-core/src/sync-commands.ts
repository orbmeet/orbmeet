// The command channel from the app Worker to the whiteboard sync servers.
//
// Ownership is one-directional. A board lives on one node at a time, the one
// D1 names with its generation: that node's room database is the board's
// working copy, saved to R2 as it changes (`whiteboardRoomCopyKey`), and the
// servers alone write snapshot bytes to R2 (immutable captures, revisions and
// restore points). The Worker owns who may do what, and where each board
// lives (D1), and asks the board's node to act through these commands. Each command is one signed POST to
// `/commands/<name>` whose JSON result is a `SyncCommandResult`: a typed
// success or a typed failure, never a transport status the caller has to
// reinterpret.
//
// Document commands carry a `commandId`. A retry with the same id joins the run
// still in progress, and a command whose effect cannot safely repeat keeps its
// outcome where the effect is (a restore or seed in the room's database, a
// capture in the captured object), so a retry returns that outcome instead of
// running again.

import * as v from "valibot";
import { truncateUtf8 } from "@orbmeet/primitives";
import { isSafeKeySegment } from "./document-keys.ts";
import { parseWhiteboardGrantPrincipalKey } from "./whiteboard-grant-principal.ts";
import { isWhiteboardRoomId, type WhiteboardRoomId } from "./whiteboard-room-id.ts";

export const SYNC_COMMAND_PATH_PREFIX = "/commands/";

/** Where one stored snapshot landed, and what it references. */
export interface SnapshotMeta {
  key: string;
  hash: string;
  documentClock: number;
  size: number;
  /** Asset objects the snapshot's asset records point at (see `snapshot-assets`). */
  assetKeys: string[];
}

interface RoomTarget {
  whiteboardRoomId: WhiteboardRoomId;
  /**
   * The board's generation in D1, which changes each time the board moves to
   * another node. A node holding an older copy loads the newest saved one
   * first; one holding a newer copy refuses the command with `conflict`, as
   * sent before the board moved on. Absent, the node uses what it holds.
   */
  generation?: number;
}

interface DocumentTarget extends RoomTarget {
  whiteboardId: string;
  commandId: string;
  /**
   * Epoch milliseconds. A command that has not started by then is refused
   * with `expired`; a restore, seed or capture that already landed still
   * returns its result. A caller that retries later with the same
   * `commandId` therefore learns the outcome without ever starting it late.
   */
  startBefore?: number;
}

export interface PendingEditorRequest {
  principalKey: string;
  userId: string;
  userName: string;
}

/** A page a command put on the board, for its caller to go to. */
export interface PageTarget {
  pageId: string;
  pageNumber: number;
}

/** The `page` of a page add's answer, as it reaches a browser through the host's own route. */
export function readPageTarget(value: unknown): PageTarget | null {
  if (!value || typeof value !== "object") return null;
  const { pageId, pageNumber } = value as Record<string, unknown>;
  return typeof pageId === "string" && pageId.startsWith("shape:") && Number.isSafeInteger(pageNumber) && (pageNumber as number) >= 1
    ? { pageId, pageNumber: pageNumber as number }
    : null;
}

/** Request and success payload of every command. */
export interface SyncCommands {
  /** Ensure the board's first page exists. */
  open: {
    request: DocumentTarget;
    result: { status: "initialized" | "already_initialized" };
  };
  /**
   * Store the board's current state at `toKey`, one of this board's revision
   * keys or Meeting capture keys; how a Meeting's shared state is pinned. Once
   * the copy exists it is the command's answer: a retry never copies a later
   * state.
   */
  capture: {
    request: DocumentTarget & { toKey: string };
    result: { copy: SnapshotMeta };
  };
  /**
   * Close every socket and refuse writes until `reopen`. Idempotent, and
   * serialized with `reopen`: a reopen sent while an archive is still running
   * takes effect after it.
   */
  archive: {
    request: DocumentTarget;
    result: { status: "archived" };
  };
  reopen: {
    request: DocumentTarget;
    result: { status: "reopened" };
  };
  /**
   * Replace the document with the snapshot at `sourceKey`. The state being
   * replaced is first written to `restorePointKey`, unless it already has the
   * target's content, in which case `restorePoint` is null.
   */
  restore: {
    request: DocumentTarget & { sourceKey: string; restorePointKey: string };
    result: { restorePoint: SnapshotMeta | null };
  };
  /**
   * Give a new board its first state: a stored snapshot (`key`), or another
   * board's current state. Refused with `conflict` when the board already has
   * a document that no earlier run of this command put there.
   */
  seed: {
    request: DocumentTarget & {
      source: { key: string } | { whiteboardRoomId: WhiteboardRoomId; whiteboardId: string };
    };
    result: { assetKeys: string[] };
  };
  /**
   * The board is moving to another node: close every socket as
   * NOT_AUTHENTICATED (each client asks the Worker again and is sent to the
   * new node), save the room to R2 and delete this node's copy. Answers which
   * generation it saved, or null when this node held no copy. With
   * `ifIdle`, refused as `busy` while anyone is connected: the board moves
   * toward whoever opens it only when no one is using it where it is.
   */
  handoff: {
    request: RoomTarget & { whiteboardId: string; ifIdle?: boolean };
    result: { savedGeneration: number | null };
  };
  /** Close the board's room and delete its database and saved copies: the board is gone. */
  purge: {
    request: RoomTarget & { whiteboardId: string };
    result: { status: "purged" };
  };
  /**
   * Re-read authority for the room from the Worker now. With `principalKey`,
   * that principal's writes are suspended until the fresh verdict lands — the
   * caller has just narrowed its authority in D1.
   */
  refreshAuthority: {
    request: RoomTarget & { principalKey?: string };
    result: { status: "scheduled" | "not_resident" };
  };
  /**
   * Copy one stored snapshot (a revision or capture) to another revision key.
   * The sync server is the only writer of whiteboard document bytes.
   */
  copySnapshot: {
    request: { sourceKey: string; destinationKey: string };
    result: { copy: SnapshotMeta };
  };
  /** Read a stored snapshot, a revision or capture (for export and handoff rendering). */
  readSnapshot: {
    request: { key: string };
    result: { snapshot: unknown; meta: SnapshotMeta };
  };
  editRequest: {
    request: RoomTarget & { principalKey: string; userId: string; userName: string | null };
    result: { status: "already_approved" | "already_pending" | "pending" | "pending_no_host" };
  };
  /** A manager resolved a pending edit request; the grant itself is already in D1. */
  editResolve: {
    request: RoomTarget & {
      targetPrincipalKey: string;
      approverId: string;
      outcome: "approved" | "denied";
    };
    result: { status: "approved" | "denied" };
  };
  pageEditValidate: {
    request: RoomTarget & { userId: string; connectionId: string; pageId: string };
    result: { status: "page_edit_validated" };
  };
  /** The caller drives the room's navigation and `pageId` is one of its pages: it may be recorded as presented. */
  pagePresentValidate: {
    request: RoomTarget & { userId: string; connectionId: string; pageId: string };
    result: { status: "page_present_validated" };
  };
  /**
   * Add a page. When the caller drives the room's navigation, the room moves
   * there with them, in the same write.
   */
  pageAdd: {
    request: RoomTarget & { userId: string; connectionId?: string; afterPageNumber?: number };
    result: { status: "page_added" | "initialized"; page: PageTarget };
  };
  navigationControllerSet: {
    request: RoomTarget & { targetUserId: string; approverId: string };
    result: { status: "navigation_controller_set"; navigationControllerUserId: string };
  };
  navigationControllerRelease: {
    request: RoomTarget & { requesterId: string };
    result: { status: "navigation_controller_released" };
  };
}

export type SyncCommandName = keyof SyncCommands;
export type SyncCommandRequest<C extends SyncCommandName> = SyncCommands[C]["request"];

// --- Protocol version --------------------------------------------------------

/**
 * The version of this channel's contract, which both directions share: the
 * Worker's commands to a node and a node's calls back to the Worker (room
 * authority, PDF import grants). The two deploy separately, so each states the
 * version it speaks on every request (`SYNC_PROTOCOL_HEADER`) and on `/health`
 * the versions it accepts, and refuses a request outside them
 * (`incompatible`) rather than misreading it.
 *
 * A change one side cannot read takes three releases: both sides first accept
 * the new version (`accepts.newest`), then both speak it (`speaks`), then stop
 * accepting the old one (`accepts.oldest`). At every step each side speaks
 * what the other accepts, whichever deploys first.
 */
export const SYNC_PROTOCOL = { speaks: 1, accepts: { oldest: 1, newest: 1 } } as const satisfies SyncProtocol;
export const SYNC_PROTOCOL_HEADER = "X-Orbmeet-Sync-Protocol";

export interface SyncProtocol {
  speaks: number;
  accepts: { oldest: number; newest: number };
}

/** The version a request speaks: one without the header predates it, and speaks 1. Null when unreadable. */
export function syncProtocolOf(header: string | null): number | null {
  if (header === null) return 1;
  return /^[1-9][0-9]{0,5}$/.test(header) ? Number(header) : null;
}

/** Whether a side with `protocol` reads a request speaking `version`. */
export function acceptsSyncProtocol(protocol: SyncProtocol, version: number | null): boolean {
  return version !== null && version >= protocol.accepts.oldest && version <= protocol.accepts.newest;
}

/** Whether two sides read each other: each speaks a version the other accepts. */
export function speaksWith(ours: SyncProtocol, theirs: SyncProtocol): boolean {
  return acceptsSyncProtocol(theirs, ours.speaks) && acceptsSyncProtocol(ours, theirs.speaks);
}

/** What a sync server's `/health` answers. */
export interface SyncHealth {
  ok: true;
  protocol: SyncProtocol;
}

/** A `/health` answer, if it is one. One without a protocol predates it: it speaks and accepts only 1. */
export function parseSyncHealth(value: unknown): SyncHealth | null {
  if (typeof value !== "object" || value === null || (value as { ok?: unknown }).ok !== true) return null;
  const protocol = (value as { protocol?: unknown }).protocol;
  if (protocol === undefined) return { ok: true, protocol: { speaks: 1, accepts: { oldest: 1, newest: 1 } } };
  const parsed = v.safeParse(protocolSchema, protocol);
  return parsed.success ? { ok: true, protocol: parsed.output } : null;
}

const version = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const protocolSchema = v.pipe(
  v.object({ speaks: version, accepts: v.object({ oldest: version, newest: version }) }),
  v.check(({ speaks, accepts }) => accepts.oldest <= speaks && speaks <= accepts.newest),
);

// --- Request schemas ---------------------------------------------------------

/** The longest object key a command names. */
const MAX_KEY_LENGTH = 512;
/** A user's name as a room shows it to managers, in UTF-8 bytes. */
const MAX_USER_NAME_BYTES = 256;

const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const finiteNumber = v.pipe(v.number(), v.finite());
const whiteboardRoomId = v.custom<WhiteboardRoomId>(
  (value) => typeof value === "string" && isWhiteboardRoomId(value),
  "Invalid whiteboard room id",
);
const whiteboardId = v.pipe(v.string(), v.check(isSafeKeySegment, "Invalid whiteboard id"));
const commandId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{8,128}$/, "Invalid command id"));
const objectKey = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_KEY_LENGTH));
/** A plain user id, or a guest's compound "${userId}_${admissionId}" identity. */
const userId = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,192}$/, "Invalid user id"));
const principalKey = v.pipe(
  v.string(),
  v.check((value) => parseWhiteboardGrantPrincipalKey(value) !== null, "Invalid principal key"),
);
const connectionId = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
/** Pages are page-frame shapes, so a page is named by its shape id. */
const pageId = v.pipe(v.string(), v.startsWith("shape:"), v.maxLength(128));
/** Control characters dropped and the rest cut to fit: a name is shown, never refused. */
const userName = v.pipe(
  v.unknown(),
  v.transform((value) =>
    typeof value === "string"
      ? truncateUtf8(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""), MAX_USER_NAME_BYTES)
      : null),
);

const roomTarget = { whiteboardRoomId, generation: v.optional(nonNegativeInteger) };
const documentTarget = { ...roomTarget, whiteboardId, commandId, startBefore: v.optional(nonNegativeInteger) };

/**
 * How a node reads each command's request. The types above are what a sender
 * may write; each schema yields that type (the `satisfies` below holds them
 * together), so a node acts only on a request the contract allows.
 */
export const SYNC_COMMAND_REQUESTS = {
  open: v.object(documentTarget),
  capture: v.object({ ...documentTarget, toKey: objectKey }),
  archive: v.object(documentTarget),
  reopen: v.object(documentTarget),
  restore: v.object({ ...documentTarget, sourceKey: objectKey, restorePointKey: objectKey }),
  seed: v.object({
    ...documentTarget,
    source: v.union([v.object({ key: objectKey }), v.object({ whiteboardRoomId, whiteboardId })], "Invalid seed source"),
  }),
  handoff: v.object({ ...roomTarget, whiteboardId, ifIdle: v.optional(v.boolean()) }),
  purge: v.object({ ...roomTarget, whiteboardId }),
  refreshAuthority: v.object({ ...roomTarget, principalKey: v.optional(principalKey) }),
  copySnapshot: v.object({ sourceKey: objectKey, destinationKey: objectKey }),
  readSnapshot: v.object({ key: objectKey }),
  editRequest: v.object({ ...roomTarget, principalKey, userId, userName: v.optional(userName, null) }),
  editResolve: v.object({
    ...roomTarget,
    targetPrincipalKey: principalKey,
    approverId: userId,
    outcome: v.picklist(["approved", "denied"]),
  }),
  pageEditValidate: v.object({ ...roomTarget, userId, connectionId, pageId }),
  pagePresentValidate: v.object({ ...roomTarget, userId, connectionId, pageId }),
  pageAdd: v.object({ ...roomTarget, userId, connectionId: v.optional(connectionId), afterPageNumber: v.optional(finiteNumber) }),
  navigationControllerSet: v.object({ ...roomTarget, targetUserId: userId, approverId: userId }),
  navigationControllerRelease: v.object({ ...roomTarget, requesterId: userId }),
} satisfies { [C in SyncCommandName]: v.GenericSchema<unknown, SyncCommandRequest<C>> };

/** A command's request as the contract reads it, or the `invalid` failure that says why it does not. */
export function parseSyncCommandRequest<C extends SyncCommandName>(
  name: C,
  body: unknown,
): SyncCommandRequest<C> | SyncCommandFailure {
  const parsed = v.safeParse(SYNC_COMMAND_REQUESTS[name], body);
  if (parsed.success) return parsed.output;
  const [issue] = parsed.issues;
  const path = issue.path?.map((item) => String(item.key)).join(".");
  return syncCommandFailure("invalid", path ? `Invalid ${path}: ${issue.message}` : issue.message);
}

export const SYNC_COMMAND_FAILURES = {
  invalid: 400,
  /** The request speaks a protocol version the receiver does not accept (see `SYNC_PROTOCOL`). */
  incompatible: 426,
  forbidden: 403,
  not_found: 404,
  expired: 410,
  conflict: 409,
  archived: 409,
  busy: 409,
  too_large: 413,
  rate_limited: 429,
  unavailable: 503,
} as const;

export type SyncCommandFailureReason = keyof typeof SYNC_COMMAND_FAILURES;

export interface SyncCommandFailure {
  ok: false;
  reason: SyncCommandFailureReason;
  message: string;
  /** Extra facts a caller can act on, e.g. the room's size limit after a refused write. */
  details?: Record<string, unknown>;
}

export type SyncCommandSuccess<C extends SyncCommandName> = { ok: true } & SyncCommands[C]["result"];
export type SyncCommandResult<C extends SyncCommandName> = SyncCommandSuccess<C> | SyncCommandFailure;

export function syncCommandFailure(
  reason: SyncCommandFailureReason,
  message: string,
  details?: Record<string, unknown>,
): SyncCommandFailure {
  return details ? { ok: false, reason, message, details } : { ok: false, reason, message };
}

/**
 * A command's JSON answer, if it is one: a success object, or a failure with a
 * known reason. The payload's shape is the contract of the protocol version
 * the command was sent under (`SYNC_PROTOCOL`), so it is not re-checked here.
 */
export function parseSyncCommandResult(value: unknown): SyncCommandResult<SyncCommandName> | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { ok?: unknown; reason?: unknown; message?: unknown };
  if (candidate.ok === true) return value as SyncCommandResult<SyncCommandName>;
  if (
    candidate.ok === false
    && typeof candidate.reason === "string"
    && Object.hasOwn(SYNC_COMMAND_FAILURES, candidate.reason)
    && typeof candidate.message === "string"
  ) {
    return value as SyncCommandFailure;
  }
  return null;
}

export function syncCommandPath(name: SyncCommandName): string {
  return `${SYNC_COMMAND_PATH_PREFIX}${name}`;
}

// A record, not a list: the type requires every command, so one added to
// `SyncCommands` cannot be left unroutable.
const COMMAND_NAMES: Record<SyncCommandName, true> = {
  open: true,
  capture: true,
  archive: true,
  reopen: true,
  restore: true,
  seed: true,
  handoff: true,
  purge: true,
  copySnapshot: true,
  readSnapshot: true,
  refreshAuthority: true,
  editRequest: true,
  editResolve: true,
  pageEditValidate: true,
  pagePresentValidate: true,
  pageAdd: true,
  navigationControllerSet: true,
  navigationControllerRelease: true,
};

export function parseSyncCommandPath(pathname: string): SyncCommandName | null {
  if (!pathname.startsWith(SYNC_COMMAND_PATH_PREFIX)) return null;
  const name = pathname.slice(SYNC_COMMAND_PATH_PREFIX.length);
  return Object.hasOwn(COMMAND_NAMES, name) ? (name as SyncCommandName) : null;
}

/** Commands that carry a `commandId`: their effect must not repeat on retry. */
export type DocumentCommandName = {
  [C in SyncCommandName]: SyncCommandRequest<C> extends { commandId: string } ? C : never;
}[SyncCommandName];

// --- Authority: sync server → Worker --------------------------------------

/** Path the sync server GETs (signed) for a room's current authority. */
export const ROOM_AUTHORITY_PATH = "/api/whiteboard/room-authority";

/** One token the room is holding a socket (or an admission) for. */
export interface AuthorityClaim {
  sub: string;
  role: string;
  connectionId: string;
  grantPrincipalKey: string;
  capabilities: {
    canEditWhiteboard: boolean;
    canControlSurface: boolean;
    canManageWhiteboard: boolean;
  };
  service?: string;
  documentId?: string;
}

export interface RoomAuthorityRequest {
  whiteboardRoomId: WhiteboardRoomId;
  /** The generation of the room asking; a room the board has moved on from hears `refresh` for every claim. */
  generation?: number;
  claims: AuthorityClaim[];
}

/**
 * What the sync server does with each socket holding a claim:
 * - `active`: the claim still matches D1 authority.
 * - `refresh`: the holder is still entitled to the room but the claim is stale
 *   (role, capability, grant, document or connection lease changed) — close
 *   the socket as transient so the client re-mints its token.
 * - `denied`: nothing a new token could fix — close terminally.
 */
export type AuthorityVerdict = "active" | "refresh" | "denied";

export interface RoomAuthorityResponse {
  /** Verdicts in the same order as the request's claims. */
  verdicts: AuthorityVerdict[];
}

/** The key that groups sockets sharing one verdict: every field D1 compares. */
export function authorityClaimKey(claim: AuthorityClaim): string {
  const capabilities = [
    claim.capabilities.canEditWhiteboard ? "e" : "-",
    claim.capabilities.canControlSurface ? "s" : "-",
    claim.capabilities.canManageWhiteboard ? "m" : "-",
  ].join("");
  // JSON, not a delimiter: no field's content can shift into another's.
  return JSON.stringify([
    claim.sub,
    claim.role,
    claim.connectionId,
    claim.grantPrincipalKey,
    capabilities,
    claim.service ?? "",
    claim.documentId ?? "",
  ]);
}

export const MAX_AUTHORITY_CLAIMS = 1_000;

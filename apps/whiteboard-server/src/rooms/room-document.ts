import { TLSocketRoom } from "@tldraw/sync-core";
import type { RoomSnapshot, TLRecordAuthorizers } from "@tldraw/sync-core";
import type { TLRecord } from "@tldraw/tlschema";
import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import {
  isWhiteboardRevisionKey,
  whiteboardIdOfDocumentKey,
} from "@orbmeet/whiteboard-core/document-keys";
import { computeWhiteboardDocumentContentHash } from "@orbmeet/whiteboard-core/room-snapshot-validation";
import {
  syncCommandFailure,
  type DocumentCommandName,
  type SyncCommandResult,
} from "@orbmeet/whiteboard-core/sync-commands";
import { extractSnapshotAssetKeys } from "@orbmeet/whiteboard-core/snapshot-assets";
import {
  openRoomDocumentStore,
  GENERATION_META_KEY,
  LIFECYCLE_META_KEY,
  readRestoreRecord,
  WHITEBOARD_ID_META_KEY,
  writeRestoreRecord,
  type RoomDocumentStore,
} from "../persistence/room-document-store.ts";
import { SnapshotUnreadableError, type SnapshotStore } from "../persistence/snapshot-store.ts";
import type { RoomPageCommands } from "./room-page-commands.ts";
import type { SessionMeta } from "./room-types.ts";
import { logError, logWarn } from "../lib/log.ts";

/** The seed command that gave this board its first state. */
const SEED_META_KEY = "seedCommandId";

type DocumentLifecycle = "writable" | "archived";

export interface DocumentCommandOptions {
  /** Epoch milliseconds after which the command must not start. */
  startBefore?: number;
}

/** What a document command needs from the room around it. */
export interface RoomDocumentHost {
  /** Hold the room open while a command runs; false once it is closing. */
  beginOperation(): boolean;
  endOperation(): void;
  /** The board was archived: every socket leaves. */
  disconnectAll(): void;
  /** A restore replaced the document wholesale. */
  documentReplaced(): void;
  ensureInitialPage(): ReturnType<RoomPageCommands["ensureInitialPage"]>;
  /** What a client may write, record by record (room-record-authorizers.ts). */
  recordAuthorizers: TLRecordAuthorizers<TLRecord, SessionMeta>;
}

/**
 * The board: its database, the tldraw room serving it, and the Worker's
 * commands on it.
 *
 * Commands run one at a time per room, and a retry with the same commandId
 * joins one still running. A command whose effect cannot be repeated safely
 * keeps its outcome where the effect is (a restore in this database, a capture
 * in the captured object), so a retry returns it instead of running again.
 * Only a command with no such record is held to `startBefore`.
 *
 * A command may await R2, but it decides after its last await: the checks and
 * the change they guard run together, synchronously.
 */
export class RoomDocument {
  readonly store: RoomDocumentStore;
  readonly sync: TLSocketRoom<TLRecord, SessionMeta>;
  private whiteboardIdValue: string | null;
  /** Persisted in the room database (`LIFECYCLE_META_KEY`); read once at open. */
  private lifecycle: DocumentLifecycle;
  /** Held while a restore replaces the document; pushes are refused meanwhile. */
  private restoring = false;
  private closed = false;
  /** Commands still running, so a retry joins one instead of starting it again. */
  private readonly running = new Map<string, Promise<SyncCommandResult<DocumentCommandName>>>();
  /** Commands run one at a time, in arrival order. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly whiteboardRoomId: WhiteboardRoomId;
  private readonly snapshots: SnapshotStore;
  private readonly host: RoomDocumentHost;

  constructor(
    whiteboardRoomId: WhiteboardRoomId,
    path: string,
    snapshots: SnapshotStore,
    host: RoomDocumentHost,
    options: { whiteboardId?: string | null; initialSnapshot?: RoomSnapshot } = {},
  ) {
    this.whiteboardRoomId = whiteboardRoomId;
    this.snapshots = snapshots;
    this.host = host;
    this.store = openRoomDocumentStore(path, options.initialSnapshot);
    // A corrupt or incompatible database throws from here on; release the
    // handle rather than leak it for the process lifetime.
    try {
      this.lifecycle = this.store.getMeta(LIFECYCLE_META_KEY) === "archived" ? "archived" : "writable";
      this.whiteboardIdValue = this.store.getMeta(WHITEBOARD_ID_META_KEY);
      this.sync = new TLSocketRoom<TLRecord, SessionMeta>({
        schema: whiteboardTLSchema,
        storage: this.store.syncStorage,
        authorizeRecord: host.recordAuthorizers,
        log: {
          warn: (...args: unknown[]) => logWarn("[Room]", whiteboardRoomId, ...args),
          error: (...args: unknown[]) => logError("[Room]", whiteboardRoomId, ...args),
        },
      });
      if (options.whiteboardId) this.bindWhiteboard(options.whiteboardId);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** The whiteboard this room hosts, once known. */
  get whiteboardId(): string | null {
    return this.whiteboardIdValue;
  }

  /** The generation this node holds the board at (`GENERATION_META_KEY`); 0 for a database from before boards moved. */
  get generation(): number {
    const generation = Number(this.store.getMeta(GENERATION_META_KEY));
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
  }

  /** Record that this node now holds the board at `generation`. */
  setGeneration(generation: number): void {
    this.store.setMeta(GENERATION_META_KEY, String(generation));
  }

  get isWritable(): boolean {
    return this.lifecycle === "writable";
  }

  canAcceptMutations(): boolean {
    return this.lifecycle === "writable" && !this.restoring;
  }

  /** Bind this room to the whiteboard it hosts; a room never changes documents. */
  bindWhiteboard(whiteboardId: string): boolean {
    if (this.whiteboardIdValue === whiteboardId) return true;
    if (this.whiteboardIdValue !== null) {
      logError(
        `[Room ${this.whiteboardRoomId}] Refusing to rebind from whiteboard ${this.whiteboardIdValue} to ${whiteboardId}`,
      );
      return false;
    }
    // Stored first: a binding only this process remembers would be gone after
    // a restart, leaving the room free to be bound to another whiteboard.
    this.store.setMeta(WHITEBOARD_ID_META_KEY, whiteboardId);
    this.whiteboardIdValue = whiteboardId;
    return true;
  }

  private run<C extends DocumentCommandName>(
    commandId: string,
    whiteboardId: string,
    options: DocumentCommandOptions,
    command: {
      /** The command's outcome, when a durable record shows it already ran. */
      recorded?: () => Promise<SyncCommandResult<C> | null>;
      run: () => SyncCommandResult<C> | Promise<SyncCommandResult<C>>;
    },
  ): Promise<SyncCommandResult<C>> {
    const running = this.running.get(commandId);
    if (running) return running;
    if (!this.bindWhiteboard(whiteboardId)) {
      return Promise.resolve(syncCommandFailure("conflict", "This room hosts a different whiteboard"));
    }
    if (!this.host.beginOperation()) {
      return Promise.resolve(syncCommandFailure("unavailable", "Whiteboard room is closing"));
    }
    const result = this.queue
      .catch(() => undefined)
      .then(async (): Promise<SyncCommandResult<C>> => {
        if (this.closed) return syncCommandFailure("unavailable", "Whiteboard room is closing");
        const recorded = await command.recorded?.();
        if (recorded) return recorded;
        if (options.startBefore !== undefined && Date.now() >= options.startBefore) {
          return syncCommandFailure("expired", "The command was not started in time");
        }
        return command.run();
      })
      .catch((error: unknown): SyncCommandResult<C> => {
        logError(`[Room ${this.whiteboardRoomId}] Document command failed:`, error);
        return syncCommandFailure("unavailable", "Whiteboard state could not be saved");
      })
      .finally(() => {
        this.running.delete(commandId);
        this.host.endOperation();
      });
    this.queue = result;
    this.running.set(commandId, result as Promise<SyncCommandResult<DocumentCommandName>>);
    return result;
  }

  /** Ensure the board's first page exists. */
  open(
    commandId: string,
    whiteboardId: string,
    options: DocumentCommandOptions = {},
  ): Promise<SyncCommandResult<"open">> {
    return this.run(commandId, whiteboardId, options, {
      run: () => {
        if (this.lifecycle === "archived") {
          return syncCommandFailure("archived", "Whiteboard is archived");
        }
        const initialization = this.host.ensureInitialPage();
        if (!initialization.ok) return initialization;
        return {
          ok: true,
          status: initialization.status === "already_initialized" ? "already_initialized" : "initialized",
        };
      },
    });
  }

  /**
   * Store the board's current state at `toKey`. The copy is its own record:
   * once it exists, a retry returns it rather than copying a later state over
   * a boundary that has passed.
   */
  capture(
    commandId: string,
    whiteboardId: string,
    toKey: string,
    options: DocumentCommandOptions = {},
  ): Promise<SyncCommandResult<"capture">> {
    if (whiteboardIdOfDocumentKey(toKey) !== whiteboardId) {
      return Promise.resolve(syncCommandFailure(
        "invalid",
        "A capture must name one of this whiteboard's revisions or Meeting captures",
      ));
    }
    return this.run(commandId, whiteboardId, options, {
      recorded: async () => {
        const copy = await this.snapshots.load(toKey);
        return copy ? { ok: true, copy: copy.meta } : null;
      },
      run: async () => ({ ok: true, copy: await this.snapshots.writeAt(toKey, this.sync.getCurrentSnapshot()) }),
    });
  }

  /** Refuse writes and close every socket until `reopen`. */
  archive(
    commandId: string,
    whiteboardId: string,
    options: DocumentCommandOptions = {},
  ): Promise<SyncCommandResult<"archive">> {
    return this.run(commandId, whiteboardId, options, {
      run: () => {
        this.setLifecycle("archived");
        this.host.disconnectAll();
        return { ok: true, status: "archived" };
      },
    });
  }

  reopen(
    commandId: string,
    whiteboardId: string,
    options: DocumentCommandOptions = {},
  ): Promise<SyncCommandResult<"reopen">> {
    return this.run(commandId, whiteboardId, options, {
      run: () => {
        this.setLifecycle("writable");
        return { ok: true, status: "reopened" };
      },
    });
  }

  private setLifecycle(lifecycle: DocumentLifecycle): void {
    this.store.setMeta(LIFECYCLE_META_KEY, lifecycle === "archived" ? "archived" : null);
    this.lifecycle = lifecycle;
  }

  /**
   * Replace the document with the snapshot at `sourceKey`, keeping the state
   * it replaces at `restorePointKey`.
   *
   * Pushes are refused from the moment the replaced state is read until the
   * replacement is applied, so every acknowledged edit is in the restore point
   * and none is lost between capture and replace.
   *
   * `loadSnapshot` applies the snapshot's *records* as a diff and never
   * imports its clocks, so the document clock keeps advancing through a
   * restore.
   */
  restore(
    commandId: string,
    whiteboardId: string,
    sourceKey: string,
    restorePointKey: string,
    options: DocumentCommandOptions = {},
  ): Promise<SyncCommandResult<"restore">> {
    if (
      !isWhiteboardRevisionKey(whiteboardId, sourceKey)
      || !isWhiteboardRevisionKey(whiteboardId, restorePointKey)
    ) {
      return Promise.resolve(
        syncCommandFailure("invalid", "Restore keys must name this whiteboard's revisions"),
      );
    }
    return this.run(commandId, whiteboardId, options, {
      recorded: async () => {
        const record = readRestoreRecord(this.store, commandId);
        return record && { ok: true, restorePoint: record.restorePoint };
      },
      run: () => this.runRestore(commandId, sourceKey, restorePointKey),
    });
  }

  private async runRestore(
    commandId: string,
    sourceKey: string,
    restorePointKey: string,
  ): Promise<SyncCommandResult<"restore">> {
    if (this.lifecycle === "archived") {
      return syncCommandFailure("archived", "Whiteboard is archived");
    }
    let source;
    try {
      source = await this.snapshots.load(sourceKey);
    } catch (error) {
      if (!(error instanceof SnapshotUnreadableError)) throw error;
      logError(`[Room ${this.whiteboardRoomId}] Restore source ${sourceKey} unreadable:`, error);
      return syncCommandFailure("conflict", "This revision's stored state could not be read");
    }
    if (!source) return syncCommandFailure("not_found", "This revision's stored state is gone");

    this.restoring = true;
    try {
      const current = this.sync.getCurrentSnapshot();
      const [currentContent, targetContent] = await Promise.all([
        computeWhiteboardDocumentContentHash(current),
        computeWhiteboardDocumentContentHash(source.snapshot),
      ]);
      if (targetContent === null) {
        return syncCommandFailure("conflict", "This revision's stored state could not be read");
      }
      // A board already showing the target's content has nothing new to undo.
      // But this command may be what put it there, before its record was
      // written: the restore point it stored then is still its answer.
      const restorePoint = currentContent === targetContent
        ? (await this.snapshots.load(restorePointKey))?.meta ?? null
        : await this.snapshots.writeAt(restorePointKey, current);
      if (this.closed) return syncCommandFailure("unavailable", "Whiteboard room is closing");
      this.sync.loadSnapshot(source.snapshot);
      this.host.documentReplaced();
      writeRestoreRecord(this.store, commandId, { restorePoint });
      return { ok: true, restorePoint };
    } finally {
      this.restoring = false;
    }
  }

  /** The board's current state, read synchronously from its database. */
  currentSnapshot(): RoomSnapshot {
    return this.sync.getCurrentSnapshot();
  }

  /** Asset objects the board's current state references. */
  assetKeys(): string[] {
    return extractSnapshotAssetKeys(this.sync.getCurrentSnapshot());
  }

  /** Whether `commandId` is the seed that gave this board its first state. */
  seededBy(commandId: string): boolean {
    return this.store.getMeta(SEED_META_KEY) === commandId;
  }

  recordSeed(commandId: string): void {
    this.store.setMeta(SEED_META_KEY, commandId);
  }

  /** Release the tldraw room, then the database it was built on. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.running.clear();
    for (const [name, release] of [
      // Absent when the constructor threw before building it.
      ["TLSocketRoom", () => this.sync?.close()],
      ["database", () => this.store.close()],
    ] as const) {
      try {
        release();
      } catch (error) {
        logError(`[Room ${this.whiteboardRoomId}] Failed to close ${name}:`, error);
      }
    }
  }
}

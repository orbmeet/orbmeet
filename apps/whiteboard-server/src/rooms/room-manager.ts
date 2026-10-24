import { TLSyncErrorCloseEventReason, type RoomSnapshot } from "@tldraw/sync-core";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import {
  syncCommandFailure,
  type SyncCommandFailure,
  type SyncCommandResult,
  type SyncCommands,
} from "@orbmeet/whiteboard-core/sync-commands";
import { isWhiteboardRevisionKey, whiteboardIdOfDocumentKey } from "@orbmeet/whiteboard-core/document-keys";
import { Room } from "./room.ts";
import type { CloseReason } from "./room-connections.ts";
import {
  ensureRoomDataDir,
  removeRoomFiles,
  roomDatabaseExists,
} from "../persistence/room-storage.ts";
import { SnapshotStore, SnapshotUnreadableError } from "../persistence/snapshot-store.ts";
import type { ObjectStore } from "../persistence/r2.ts";
import { acquireSingleWriterLock, type WriterLock } from "../persistence/writer-lock.ts";
import type { AuthorityValidator } from "../http/authority-client.ts";
import type { AssistantModel } from "../assistant/assistant-model.ts";
import { RoomCapacityError, RoomManagerUnavailableError } from "./room-manager-types.ts";
import { mapWithConcurrency } from "@orbmeet/primitives";
import {
  deleteRoomCopies,
  forgetRoomCopy,
  loadRoomCopy,
  newestRoomCopy,
  removeLegacyCopyMarker,
  roomGenerationOnDisk,
  roomIds,
  saveRoomCopy,
  writeGenerationOnDisk,
} from "../persistence/room-copies.ts";
import { logError } from "../lib/log.ts";

export type { SocketSession } from "./room-types.ts";

export interface RoomManagerOptions {
  objects: ObjectStore;
  authority: AuthorityValidator;
  /** Authority sweep cadence across every resident room. */
  tickIntervalMs?: number;
  /** The pause between rounds that save each resident room that changed to R2. */
  saveIntervalMs?: number;
  onWriterLockLost?: () => void;
  /** Shared by every room's assistant; null when no model is configured. */
  assistantModel?: AssistantModel | null;
}

type SeedSource = SyncCommands["seed"]["request"]["source"];

/**
 * Every room this process hosts.
 *
 * A board lives on one node at a time, at the generation D1 gives it there,
 * and its room database on that node is the working copy, saved to R2 as it
 * changes (`room-copies.ts`). A request carrying a generation is prepared
 * first: a node holding an older copy, or none, loads the newest saved one,
 * and one holding a newer copy refuses the request as sent before the board
 * moved on. After that, opening a room only opens its file, which is
 * synchronous, so a decision about a room and the act it decides are never
 * separated by an await. Snapshots in R2 (revisions, captures, restore
 * points) are immutable copies and are never read to open a room.
 */
export class RoomManager {
  private static readonly MAX_ROOMS = 500;
  /** Room saves running at once; libuv's thread pool has four threads by default. */
  private static readonly SAVE_CONCURRENCY = 2;
  private readonly rooms = new Map<WhiteboardRoomId, Room>();
  /** Boards being deleted: their rooms take no new work and are never reopened. */
  private readonly purges = new Map<WhiteboardRoomId, Promise<SyncCommandResult<"purge">>>();
  /** Boards moving to another node: like purges, their rooms take no new work. */
  private readonly handoffs = new Map<WhiteboardRoomId, Promise<SyncCommandResult<"handoff">>>();
  /** Rooms being brought to a newer generation; they open once it lands. */
  private readonly preparing = new Map<WhiteboardRoomId, Promise<SyncCommandFailure | null>>();
  /** The generation a board this node has no database for yet is created at. */
  private readonly newBoardGenerations = new Map<WhiteboardRoomId, number>();
  /** Each room's save in flight. A room is saved by at most one at a time. */
  private readonly saves = new Map<WhiteboardRoomId, Promise<number | null>>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly snapshots: SnapshotStore;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private writerLock: WriterLock | null = null;
  private writerLockLost = false;
  private lifecycle: "active" | "closing" | "closed" = "active";

  private readonly dataDir: string;
  private readonly options: RoomManagerOptions;

  constructor(
    dataDir: string,
    options: RoomManagerOptions,
  ) {
    this.dataDir = dataDir;
    this.options = options;
    this.snapshots = new SnapshotStore(options.objects);
    ensureRoomDataDir(this.dataDir);
    removeLegacyCopyMarker(this.dataDir);
    this.writerLock = acquireSingleWriterLock(this.dataDir, {
      onLost: () => this.handleWriterLockLost(),
    });
    this.tickTimer = setInterval(() => this.tick(), options.tickIntervalMs ?? 15_000);
    this.tickTimer.unref?.();
    this.scheduleSaveRound();
  }

  /**
   * The next round of saves, once the pause after the last one has passed. A
   * round never overlaps the one before it, so a slow R2 stretches the
   * cadence rather than piling rounds up behind it.
   */
  private scheduleSaveRound(): void {
    this.saveTimer = setTimeout(() => void this.runSaveRound(), this.options.saveIntervalMs ?? 60_000);
    this.saveTimer.unref?.();
  }

  private async runSaveRound(): Promise<void> {
    await this.saveRooms([...this.rooms.keys()], { fresh: false });
    if (this.lifecycle === "active") this.scheduleSaveRound();
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  /**
   * The room for a board whose database exists, opened if it is not resident.
   * Null when there is none, it cannot be opened, it holds a different board,
   * or the board is being purged. Never creates a board.
   */
  openRoom(whiteboardRoomId: WhiteboardRoomId, whiteboardId?: string): Room | null {
    this.assertAcceptingWork();
    if (this.isFenced(whiteboardRoomId)) return null;
    const room = this.rooms.get(whiteboardRoomId)
      ?? (roomDatabaseExists(this.dataDir, whiteboardRoomId)
        ? this.createRoom(whiteboardRoomId, whiteboardId)
        : null);
    return room && this.hostsBoard(room, whiteboardRoomId, whiteboardId) ? room : null;
  }

  /**
   * The board's room, creating its database when it has none: for callers
   * the Worker has already confirmed the board exists for (an admitted
   * socket, a document command).
   */
  private openOrCreateRoom(whiteboardRoomId: WhiteboardRoomId, whiteboardId: string | undefined): Room | null {
    this.assertAcceptingWork();
    if (this.isFenced(whiteboardRoomId)) return null;
    const room = this.rooms.get(whiteboardRoomId) ?? this.createRoom(whiteboardRoomId, whiteboardId);
    return room && this.hostsBoard(room, whiteboardRoomId, whiteboardId) ? room : null;
  }

  /** Purged, moving away, or still loading a newer copy: the room must not open now. */
  private isFenced(whiteboardRoomId: WhiteboardRoomId): boolean {
    return this.purges.has(whiteboardRoomId)
      || this.handoffs.has(whiteboardRoomId)
      || this.preparing.has(whiteboardRoomId);
  }

  /**
   * Bring the room to `generation` before a request for it is served: load
   * the newest saved copy when this node's copy is older (or absent), and
   * refuse with `conflict` when it is newer, since the request was made for
   * a generation the board has moved on from. Null when the request may go
   * ahead; with no generation, it always may.
   */
  async prepare(whiteboardRoomId: WhiteboardRoomId, generation: number | undefined): Promise<SyncCommandFailure | null> {
    if (generation === undefined) return null;
    this.assertAcceptingWork();
    for (;;) {
      if (this.purges.has(whiteboardRoomId)) return syncCommandFailure("not_found", "This whiteboard is being deleted");
      if (this.handoffs.has(whiteboardRoomId)) {
        return syncCommandFailure("conflict", "This whiteboard is moving to another node");
      }
      const running = this.preparing.get(whiteboardRoomId);
      if (!running) break;
      await running;
    }
    const run = this.prepareNow(whiteboardRoomId, generation)
      .catch((error: unknown) => {
        logError(`[RoomManager] ${whiteboardRoomId}: could not load generation ${generation}`, error);
        return syncCommandFailure("unavailable", "Whiteboard state could not be loaded");
      })
      .finally(() => this.preparing.delete(whiteboardRoomId));
    this.preparing.set(whiteboardRoomId, run);
    return run;
  }

  private async prepareNow(whiteboardRoomId: WhiteboardRoomId, generation: number): Promise<SyncCommandFailure | null> {
    const moved = () => syncCommandFailure("conflict", "This whiteboard has moved to another node");
    const resident = this.rooms.get(whiteboardRoomId);
    if (resident) {
      const held = resident.document.generation;
      if (held === generation) return null;
      if (held > generation) return moved();
      // The board went elsewhere and came back without this node hearing:
      // what it holds is older than what was saved meanwhile.
      await this.closeResidentRoom(resident, TLSyncErrorCloseEventReason.NOT_AUTHENTICATED);
    }
    this.assertAcceptingWork();
    const onDisk = roomGenerationOnDisk(this.dataDir, whiteboardRoomId);
    if (onDisk === generation) return null;
    if (onDisk !== null && onDisk > generation) return moved();
    const newest = await newestRoomCopy(this.options.objects, whiteboardRoomId, generation);
    this.assertAcceptingWork();
    // A copy this node holds at a generation no older than the newest saved
    // one is that copy or newer: this node held the board last.
    if (newest && (onDisk === null || newest.generation > onDisk)) {
      await loadRoomCopy({ dataDir: this.dataDir, objects: this.options.objects, whiteboardRoomId, key: newest.key });
    }
    if (onDisk === null && !newest) {
      // Nothing of this board anywhere: it is new, and is created here.
      this.newBoardGenerations.set(whiteboardRoomId, generation);
    } else {
      writeGenerationOnDisk(this.dataDir, whiteboardRoomId, generation);
    }
    return null;
  }

  /** Close a resident room once its running commands finish, sending its clients away with `reason`. */
  private async closeResidentRoom(room: Room, reason: CloseReason): Promise<void> {
    room.connections.stopAcceptingOperations();
    await room.connections.waitForOperations();
    room.connections.revokeAll(reason);
    room.close();
    if (this.rooms.get(room.whiteboardRoomId) === room) this.rooms.delete(room.whiteboardRoomId);
  }

  /**
   * The board is moving to another node: send its clients to the Worker
   * (which names the new node), save the room to R2, and delete this node's
   * copy. Refused with `conflict` when this node holds a newer generation
   * than the move was decided from, and with `ifIdle` refused with `busy`
   * while anyone is connected. Idempotent; a handoff already running is
   * joined.
   */
  handoff(
    whiteboardRoomId: WhiteboardRoomId,
    whiteboardId: string,
    generation: number | undefined,
    { ifIdle = false }: { ifIdle?: boolean } = {},
  ): Promise<SyncCommandResult<"handoff">> {
    this.assertAcceptingWork();
    const running = this.handoffs.get(whiteboardRoomId);
    if (running) return running;
    if (this.purges.has(whiteboardRoomId)) return Promise.resolve({ ok: true, savedGeneration: null });
    // Decided before the handoff fences the room, so a refusal leaves it as it was.
    if (ifIdle && this.rooms.get(whiteboardRoomId)?.isEmpty() === false) {
      return Promise.resolve(syncCommandFailure("busy", "Someone is using this whiteboard here"));
    }
    const handoff = (async (): Promise<SyncCommandResult<"handoff">> => {
      await this.preparing.get(whiteboardRoomId);
      const room = this.rooms.get(whiteboardRoomId);
      if (room && room.document.whiteboardId !== null && room.document.whiteboardId !== whiteboardId) {
        return syncCommandFailure("conflict", "This room hosts a different whiteboard");
      }
      const held = room?.document.generation ?? roomGenerationOnDisk(this.dataDir, whiteboardRoomId);
      if (held === null) {
        forgetRoomCopy(this.dataDir, whiteboardRoomId);
        return { ok: true, savedGeneration: null };
      }
      if (generation !== undefined && held > generation) {
        return syncCommandFailure("conflict", "This node holds a newer generation of the whiteboard");
      }
      if (room) await this.closeResidentRoom(room, TLSyncErrorCloseEventReason.NOT_AUTHENTICATED);
      this.assertAcceptingWork();
      let savedGeneration: number | null;
      try {
        savedGeneration = await this.saveRoom(whiteboardRoomId, { fresh: true });
      } catch (error) {
        // The copy stays here, and the board with it: the Worker moves it
        // only once a handoff succeeds.
        logError(`[RoomManager] ${whiteboardRoomId}: could not save before handing off`, error);
        return syncCommandFailure("unavailable", "Whiteboard state could not be saved");
      }
      this.assertAcceptingWork();
      removeRoomFiles(this.dataDir, whiteboardRoomId);
      forgetRoomCopy(this.dataDir, whiteboardRoomId);
      return { ok: true, savedGeneration };
    })().finally(() => this.handoffs.delete(whiteboardRoomId));
    this.handoffs.set(whiteboardRoomId, handoff);
    return handoff;
  }

  /**
   * Save the room's database to R2 if it changed since its last copy.
   *
   * A room is saved by one save at a time. With `fresh: false` (the periodic
   * round) a save already running is the answer: it began moments ago, and
   * what changed since is the next round's. With `fresh: true` (a handoff, a
   * shutdown) the save starts after any running one, so it holds everything
   * written before it was asked for.
   */
  private saveRoom(whiteboardRoomId: WhiteboardRoomId, { fresh }: { fresh: boolean }): Promise<number | null> {
    const running = this.saves.get(whiteboardRoomId);
    if (running && !fresh) return running;
    const save: Promise<number | null> = (running ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        // A board being deleted is not saved: its copy would outlive the purge.
        if (this.purges.has(whiteboardRoomId)) return null;
        this.assertStorageWriterOwned();
        return saveRoomCopy({ dataDir: this.dataDir, objects: this.options.objects, whiteboardRoomId });
      })
      .finally(() => {
        if (this.saves.get(whiteboardRoomId) === save) this.saves.delete(whiteboardRoomId);
      });
    this.saves.set(whiteboardRoomId, save);
    return save;
  }

  /**
   * Save each of these rooms that changed, a few at a time: each save copies
   * a database on libuv's small thread pool and uploads it. A failure is
   * logged and the room tried again next round.
   */
  async saveRooms(whiteboardRoomIds: readonly WhiteboardRoomId[], { fresh }: { fresh: boolean }): Promise<void> {
    await mapWithConcurrency(whiteboardRoomIds, RoomManager.SAVE_CONCURRENCY, async (whiteboardRoomId) => {
      try {
        await this.saveRoom(whiteboardRoomId, { fresh });
      } catch (error) {
        logError(`[RoomManager] ${whiteboardRoomId}: could not save to R2`, error);
      }
    });
  }

  /** Save every room database on this node that changed since its last copy: on start, what a stop left unsaved. */
  saveAllRooms(): Promise<void> {
    return this.saveRooms(roomIds(this.dataDir) as WhiteboardRoomId[], { fresh: true });
  }

  private hostsBoard(room: Room, whiteboardRoomId: WhiteboardRoomId, whiteboardId: string | undefined): boolean {
    if (whiteboardId === undefined || room.document.whiteboardId === whiteboardId) return true;
    logError(`[RoomManager] ${whiteboardRoomId} holds whiteboard ${room.document.whiteboardId}, not ${whiteboardId}`);
    return false;
  }

  /**
   * The room an admitted socket joins. The caller connects the socket in the
   * same synchronous turn; a room whose socket never arrives is retired by
   * its own idle reaper.
   */
  openRoomForSocket(whiteboardRoomId: WhiteboardRoomId, whiteboardId?: string): Room | null {
    return this.openOrCreateRoom(whiteboardRoomId, whiteboardId);
  }

  /** Run `operation` on the board's room, opening it first. */
  withRoom<T>(
    whiteboardRoomId: WhiteboardRoomId,
    whiteboardId: string,
    operation: (room: Room) => T,
  ): T | SyncCommandFailure {
    const room = this.openOrCreateRoom(whiteboardRoomId, whiteboardId);
    if (!room) return syncCommandFailure("unavailable", "Whiteboard state could not be loaded");
    return operation(room);
  }

  /**
   * Give a new board its first state. The source is read first, and the
   * only await is that read; whether the board is new is decided after it.
   */
  async seed(
    whiteboardRoomId: WhiteboardRoomId,
    whiteboardId: string,
    commandId: string,
    source: SeedSource,
  ): Promise<SyncCommandResult<"seed">> {
    this.assertAcceptingWork();
    let snapshot: RoomSnapshot | undefined;
    if ("key" in source) {
      if (!whiteboardIdOfDocumentKey(source.key)) {
        return syncCommandFailure("invalid", "The seed must name a revision or capture");
      }
      try {
        const loaded = await this.snapshots.load(source.key);
        if (!loaded) return syncCommandFailure("not_found", "Source snapshot not found");
        snapshot = loaded.snapshot;
      } catch (error) {
        if (error instanceof SnapshotUnreadableError) {
          return syncCommandFailure("conflict", "Source snapshot is unreadable");
        }
        logError(`[RoomManager] Reading seed ${source.key} failed:`, error);
        return syncCommandFailure("unavailable", "Source snapshot could not be read");
      }
    } else if (this.rooms.has(source.whiteboardRoomId) || roomDatabaseExists(this.dataDir, source.whiteboardRoomId)) {
      const sourceRoom = this.openRoom(source.whiteboardRoomId, source.whiteboardId);
      if (!sourceRoom) return syncCommandFailure("unavailable", "Source whiteboard could not be loaded");
      snapshot = sourceRoom.document.currentSnapshot();
    }
    // Otherwise the source has no database: nobody has opened it, so it is
    // empty and so is its copy. The source itself is left as it is; reading
    // it must not create it.

    if (this.purges.has(whiteboardRoomId) || this.handoffs.has(whiteboardRoomId)) {
      return syncCommandFailure("conflict", "The destination whiteboard is being deleted or moved");
    }
    if (this.rooms.has(whiteboardRoomId) || roomDatabaseExists(this.dataDir, whiteboardRoomId)) {
      const existing = this.openRoom(whiteboardRoomId, whiteboardId);
      return existing?.document.seededBy(commandId)
        ? { ok: true, assetKeys: existing.document.assetKeys() }
        : syncCommandFailure("conflict", "The destination whiteboard already has state");
    }
    this.assertAcceptingWork();
    const room = this.createRoom(whiteboardRoomId, whiteboardId, snapshot);
    if (!room) return syncCommandFailure("unavailable", "Whiteboard state could not be saved");
    room.document.recordSeed(commandId);
    return { ok: true, assetKeys: room.document.assetKeys() };
  }

  /**
   * Delete the board: refuse new work on its room, let running commands
   * finish (a capture mid-upload lands before the board's objects are
   * deleted, not after), then close it and delete its database and copies.
   * Idempotent; a purge already running is joined.
   *
   * The purge is fenced in before any of its work runs, so nothing that
   * writes the board's files can start once it has begun: `prepare` refuses,
   * and a save that has not started yet saves nothing. What had already
   * started — a load of a newer copy, a save on its way to R2 — is waited
   * for, so it lands before the files and copies are deleted, never after.
   */
  purge(whiteboardRoomId: WhiteboardRoomId, whiteboardId: string): Promise<SyncCommandResult<"purge">> {
    this.assertAcceptingWork();
    const running = this.purges.get(whiteboardRoomId);
    if (running) return running;
    const room = this.rooms.get(whiteboardRoomId)
      ?? (roomDatabaseExists(this.dataDir, whiteboardRoomId) ? this.createRoom(whiteboardRoomId) : null);
    // A room that never recorded its board is this room id's board all the same.
    if (room && room.document.whiteboardId !== null && room.document.whiteboardId !== whiteboardId) {
      return Promise.resolve(syncCommandFailure("conflict", "This room hosts a different whiteboard"));
    }
    const purge = Promise.resolve()
      .then(() => this.purgeNow(whiteboardRoomId, room))
      .finally(() => this.purges.delete(whiteboardRoomId));
    this.purges.set(whiteboardRoomId, purge);
    return purge;
  }

  private async purgeNow(whiteboardRoomId: WhiteboardRoomId, room: Room | null): Promise<SyncCommandResult<"purge">> {
    await Promise.allSettled([this.preparing.get(whiteboardRoomId), this.saves.get(whiteboardRoomId)]);
    if (room) {
      room.connections.stopAcceptingOperations();
      await room.connections.waitForOperations();
      room.closeForPurge();
      if (this.rooms.get(whiteboardRoomId) === room) this.rooms.delete(whiteboardRoomId);
    }
    // Shutdown may have begun while commands drained; the files are then
    // no longer this process's to delete, and the Worker retries.
    this.assertAcceptingWork();
    removeRoomFiles(this.dataDir, whiteboardRoomId);
    forgetRoomCopy(this.dataDir, whiteboardRoomId);
    this.newBoardGenerations.delete(whiteboardRoomId);
    await deleteRoomCopies(this.options.objects, whiteboardRoomId);
    return { ok: true, status: "purged" };
  }

  /** Copy a stored snapshot (a revision or capture) to a revision key. */
  async copySnapshot(sourceKey: string, destinationKey: string): Promise<SyncCommandResult<"copySnapshot">> {
    this.assertAcceptingWork();
    const destinationBoard = whiteboardIdOfDocumentKey(destinationKey);
    if (
      !whiteboardIdOfDocumentKey(sourceKey)
      || !destinationBoard
      || !isWhiteboardRevisionKey(destinationBoard, destinationKey)
    ) {
      return syncCommandFailure("invalid", "Copies go from a stored snapshot to a revision");
    }
    try {
      const source = await this.snapshots.load(sourceKey);
      if (!source) return syncCommandFailure("not_found", "Source snapshot not found");
      return { ok: true, copy: await this.snapshots.writeAt(destinationKey, source.snapshot) };
    } catch (error) {
      if (error instanceof SnapshotUnreadableError) {
        return syncCommandFailure("conflict", "Source snapshot is unreadable");
      }
      logError(`[RoomManager] Copy ${sourceKey} -> ${destinationKey} failed:`, error);
      return syncCommandFailure("unavailable", "Snapshot could not be copied");
    }
  }

  async readSnapshot(key: string): Promise<SyncCommandResult<"readSnapshot">> {
    if (!whiteboardIdOfDocumentKey(key)) {
      return syncCommandFailure("invalid", "Key must name a revision or capture");
    }
    try {
      const loaded = await this.snapshots.load(key);
      if (!loaded) return syncCommandFailure("not_found", "Snapshot not found");
      return { ok: true, snapshot: loaded.snapshot, meta: loaded.meta };
    } catch (error) {
      if (error instanceof SnapshotUnreadableError) {
        return syncCommandFailure("conflict", "Snapshot is unreadable");
      }
      logError(`[RoomManager] Read ${key} failed:`, error);
      return syncCommandFailure("unavailable", "Snapshot could not be read");
    }
  }

  /**
   * Open a board's database as a resident room. A board can only be created
   * under a known whiteboard id; one whose database cannot be opened stays
   * unavailable, with the file left where it is for recovery.
   */
  private createRoom(
    whiteboardRoomId: WhiteboardRoomId,
    whiteboardId?: string,
    initialSnapshot?: RoomSnapshot,
  ): Room | null {
    if (whiteboardId === undefined && !roomDatabaseExists(this.dataDir, whiteboardRoomId)) return null;
    if (this.rooms.size >= RoomManager.MAX_ROOMS) throw new RoomCapacityError();
    let room: Room;
    try {
      room = new Room(whiteboardRoomId, this.dataDir, () => {
        if (this.rooms.get(whiteboardRoomId) === room) this.rooms.delete(whiteboardRoomId);
        // Nobody is left: save what they did now rather than at the next tick.
        if (this.servesLiveTraffic()) void this.saveRooms([whiteboardRoomId], { fresh: true });
      }, {
        snapshots: this.snapshots,
        authority: this.options.authority,
        whiteboardId: whiteboardId ?? null,
        initialSnapshot,
        assistantModel: this.options.assistantModel ?? null,
      });
    } catch (error) {
      logError(`[RoomManager] ${whiteboardRoomId}: its database could not be opened; not serving it`, error);
      return null;
    }
    const generation = this.newBoardGenerations.get(whiteboardRoomId);
    if (generation !== undefined) {
      this.newBoardGenerations.delete(whiteboardRoomId);
      try {
        room.document.setGeneration(generation);
      } catch (error) {
        logError(`[RoomManager] ${whiteboardRoomId}: could not record its generation; not serving it`, error);
        room.close();
        return null;
      }
    }
    this.rooms.set(whiteboardRoomId, room);
    return room;
  }

  getRoomIfExists(whiteboardRoomId: WhiteboardRoomId): Room | null {
    if (!this.servesLiveTraffic()) return null;
    // A room draining for its purge takes no more work, live or managed.
    if (this.purges.has(whiteboardRoomId)) return null;
    return this.rooms.get(whiteboardRoomId) ?? null;
  }

  /**
   * Unfenced lookup for teardown only. Releasing in-memory session state is
   * always safe, and a close that arrives during shutdown must still reach
   * `handleClose`.
   */
  getRoomForTeardown(whiteboardRoomId: WhiteboardRoomId): Room | null {
    return this.rooms.get(whiteboardRoomId) ?? null;
  }

  private tick(): void {
    if (!this.servesLiveTraffic()) return;
    for (const room of this.rooms.values()) room.authority.tick();
  }

  beginShutdown(): void {
    if (this.lifecycle !== "active") return;
    this.lifecycle = "closing";
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  /** Let running commands finish, then close every room. Each database already holds its state. */
  async closeAll(): Promise<void> {
    if (this.lifecycle === "closed") return;
    this.beginShutdown();
    const rooms = [...this.rooms.values()];
    for (const room of rooms) room.connections.stopAcceptingOperations();
    await Promise.allSettled(rooms.map((room) => room.connections.waitForOperations()));
    for (const room of rooms) room.close();
    this.rooms.clear();
    // What the closed rooms did since their last save goes to R2 before the
    // process stops: the next node to hold them starts from it.
    if (!this.writerLockLost) await this.saveRooms(rooms.map((room) => room.whiteboardRoomId), { fresh: true });
    this.writerLock?.release();
    this.writerLock = null;
    this.lifecycle = "closed";
  }

  /** Storage-side helpers outside RoomManager share the same data directory. */
  assertStorageWriterOwned(): void {
    if (!this.writerLock || this.writerLockLost || this.lifecycle === "closed") {
      throw new RoomManagerUnavailableError("Whiteboard writer lock is not owned");
    }
    this.writerLock.assertOwned();
  }

  private servesLiveTraffic(): boolean {
    return this.lifecycle === "active" && !this.writerLockLost;
  }

  private assertAcceptingWork(): void {
    if (this.lifecycle !== "active") {
      throw new RoomManagerUnavailableError("Whiteboard room manager is shutting down");
    }
    this.assertStorageWriterOwned();
  }

  private handleWriterLockLost(): void {
    if (this.writerLockLost) return;
    this.writerLockLost = true;
    for (const room of this.rooms.values()) room.connections.stopAcceptingOperations();
    logError("[RoomManager] Writer lock ownership lost; refusing further room access");
    this.options.onWriterLockLost?.();
  }
}

import { ConnectionState, RoomEvent, type Room } from "livekit-client";
import type { MeetingSurfaceState } from "@/modules/meetings/contract/live-state";
import type { MeetingSurfaceAccess } from "@/modules/meetings/contract/types";
import type { WhiteboardConnectAttempt } from "@orbmeet/whiteboard-client/react";
import {
  WhiteboardCredentials,
  type MintedWhiteboardAccess,
} from "@/modules/whiteboards/client/meeting/whiteboard-credentials";

// How long the canvas itself (tldraw sync → synced-remote + first pages) may
// take once credentials are in hand and its WebSocket connection has begun.
const CANVAS_READY_TIMEOUT_MS = 15_000;
/** Without a usable credential for this long, the board is shown as failed (minting continues). */
const ACCESS_FAILED_AFTER_MS = 8_000;
const MINT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const TEMPORARILY_DISABLED_REASON = "Whiteboard service is unavailable or being updated.";

export type WhiteboardViewState = "idle" | "loading" | "reconnecting" | "ready" | "fatal";
export type WhiteboardCanvasStatus = "loading" | "ready" | "fatal";

/** Everything the meeting renders about its whiteboard, as one immutable value. */
export interface WhiteboardSessionSnapshot {
  /** The meeting-wide surface is open (it may still be hidden locally). */
  sharedSurfaceOpen: boolean;
  /** This participant is showing the surface. */
  locallyVisible: boolean;
  view: WhiteboardViewState;
  canAttemptOpen: boolean;
  disabledReason: string | null;
  /** The board the meeting presents. */
  whiteboardId: string | null;
  /** The board this participant's credential is for; the canvas mounts it. */
  documentId: string | null;
  documentTitle: string | null;
  accessReady: boolean;
  token: string | null;
  wsUrl: string | null;
  canEdit: boolean;
  canManage: boolean;
}

export interface WhiteboardSessionApi {
  mintAccess(): Promise<MintedWhiteboardAccess>;
  writeSurface(open: boolean): Promise<MeetingSurfaceState>;
}

export interface WhiteboardSessionOptions {
  connectionId: string;
  surface: MeetingSurfaceAccess | undefined;
  canModerate: boolean;
  api: WhiteboardSessionApi;
  /**
   * The meeting opens on its board. A moderator's session opens the shared
   * surface once, when the room reports that nobody has opened or closed it
   * yet (revision 0). After that, the room's surface is the only authority:
   * a board someone closed stays closed for this connection and the next.
   */
  openOnStart?: boolean;
  /** The user started waiting for a board: start metrics and preload the canvas. */
  onOpening?: () => void;
  logError: (message: string, error: unknown) => void;
  logWarn?: (message: string) => void;
  now?: () => number;
}

type SessionRoom = Pick<Room, "on" | "off" | "state">;

/**
 * One participant's whiteboard for one meeting connection.
 *
 * The meeting's room owns the surface and reports it in room metadata; this
 * converges on it. On every change and on a timer it compares what should be
 * true (the surface is open, showing board X, and this participant has not
 * hidden it) with what is (the credential held, the canvas state) and does
 * the one thing that closes the gap. A failure is simply retried by the next
 * pass, so nothing here has to remember which request came last.
 */
export class WhiteboardSession {
  private readonly credentials: WhiteboardCredentials;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private snapshot: WhiteboardSessionSnapshot;

  private readonly joinAvailable: boolean;
  private readonly joinDisabledReason: string | null;
  private canModerate: boolean;
  private room: SessionRoom | null = null;
  private stopWatchingRoom: (() => void) | null = null;
  private livekitConnected = false;
  private active = false;

  /** The latest surface known, from room metadata or a command's reply. */
  private surface: MeetingSurfaceState;
  /** This participant hid the surface opened at this revision. */
  private hiddenAtOpenRevision: number | null = null;
  /** This participant asked to open it; shown before the room confirms. */
  private opening = false;
  private canvas: WhiteboardCanvasStatus = "loading";
  /** Since when the canvas has been connecting with a usable credential. */
  private canvasLoadingSince: number | null = null;
  /** The board the canvas status is about; another board's canvas starts over. */
  private canvasDocumentId: string | null = null;
  /** Since when the surface has been wanted without a usable credential. */
  private waitingSince: number | null = null;
  private mintFailures = 0;
  private mintRetryAt = 0;
  /** `openOnStart` fires at most once per session, success or not. */
  private startOpenAttempted = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: WhiteboardSessionOptions) {
    const { surface } = options;
    this.now = options.now ?? Date.now;
    this.joinAvailable = surface?.availability === "available";
    this.joinDisabledReason = surface?.disabledReason ?? null;
    this.canModerate = options.canModerate;
    // What the join saw, until room metadata says more. A negative revision
    // loses to anything the room reports.
    this.surface = {
      open: surface?.availability === "available" && surface.surfaceOpen,
      whiteboardId: surface?.documentId ?? null,
      revision: -1,
      openRevision: -1,
    };
    this.credentials = new WhiteboardCredentials({
      connectionId: options.connectionId,
      initial: {
        token: surface?.token ?? null,
        url: surface?.url ?? null,
        documentId: surface?.documentId ?? null,
        documentTitle: surface?.documentTitle ?? null,
      },
      mint: () => options.api.mintAccess(),
      onChange: () => this.changed(),
      now: this.now,
    });
    this.snapshot = this.buildSnapshot();
  }

  // ─── React binding ─────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): WhiteboardSessionSnapshot => this.snapshot;

  /** Start converging. Restartable, so a remount resumes the same session. */
  activate(): void {
    if (this.active) return;
    this.active = true;
    this.watchRoom();
    this.changed();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.stopWatchingRoom?.();
    this.stopWatchingRoom = null;
    this.clearTimer();
  }

  setRoom(room: SessionRoom | undefined): void {
    if ((room ?? null) === this.room) return;
    this.stopWatchingRoom?.();
    this.stopWatchingRoom = null;
    this.room = room ?? null;
    if (this.active) this.watchRoom();
    this.changed();
  }

  setCanModerate(canModerate: boolean): void {
    if (canModerate === this.canModerate) return;
    this.canModerate = canModerate;
    this.changed();
  }

  /** The room's surface, as its metadata reports it. Older reports are ignored. */
  setSurface(surface: MeetingSurfaceState | null): void {
    if (!surface || surface.revision <= this.surface.revision) return;
    this.surface = surface;
    if (surface.open) this.opening = false;
    this.changed();
  }

  // ─── Commands ──────────────────────────────────────────────────────────

  /** Open the whiteboard for everyone (moderators only). */
  async openShared(): Promise<void> {
    if (!this.canAttemptOpen || !this.canModerate) return;
    // Immediate feedback, and the canvas download overlaps the room's write.
    this.opening = true;
    this.hiddenAtOpenRevision = null;
    this.options.onOpening?.();
    this.changed();
    try {
      this.setSurface(await this.options.api.writeSurface(true));
    } catch (error) {
      this.options.logError("[whiteboard] Failed to open the shared surface", error);
      throw error;
    } finally {
      // The room answered: from here its surface decides what shows.
      this.opening = false;
      this.changed();
    }
  }

  /**
   * This participant presented a board: show it to them even if they had
   * hidden the surface, and take the room's answer without waiting for
   * metadata.
   */
  presented(surface: MeetingSurfaceState): void {
    this.hiddenAtOpenRevision = null;
    this.setSurface(surface);
    this.changed();
  }

  /**
   * The Board view: show the meeting's board, opening it for everyone first
   * when a moderator asks for one the meeting does not have open.
   */
  async showBoard(): Promise<void> {
    if (this.surface.open) {
      this.showLocally();
      return;
    }
    await this.openShared();
  }

  /**
   * The Talk view: this participant looks at faces instead of the board. The
   * board stays open for everyone else, whoever asks — a moderator closes it
   * for the room only through `hideOrClose`.
   */
  showTalk(): void {
    this.hideLocally();
  }

  /** Show a surface the meeting already has open. */
  showLocally(): void {
    if (!this.surface.open || !this.canAttemptOpen) return;
    this.hiddenAtOpenRevision = null;
    this.options.onOpening?.();
    this.changed();
  }

  /** Moderators close the surface for everyone; others hide it for themselves. */
  async hideOrClose(): Promise<void> {
    if (!this.canModerate) {
      this.hideLocally();
      return;
    }
    try {
      this.setSurface(await this.options.api.writeSurface(false));
    } catch (error) {
      this.options.logError("[whiteboard] Failed to close the shared surface", error);
      throw error;
    }
  }

  /**
   * Dismiss a surface that failed on this client. A load error or canvas crash
   * is local, so it never closes the board for everyone else.
   */
  dismiss(): void {
    this.hideLocally();
  }

  // ─── Canvas reports ────────────────────────────────────────────────────

  canvasStatusChanged = (status: WhiteboardCanvasStatus): void => {
    this.canvas = status;
    if (status !== "loading") this.canvasLoadingSince = null;
    this.changed();
  };

  canvasConnectionChanged = (status: "online" | "offline"): void => {
    if (this.credentials.connectionStatusChanged(status)) this.changed();
  };

  /** The URI for one sync-adapter connection attempt. */
  webSocketUri = (attempt?: WhiteboardConnectAttempt): Promise<string> =>
    this.credentials.webSocketUri(this.surface, attempt);

  // ─── Convergence ───────────────────────────────────────────────────────

  private get locallyVisible(): boolean {
    if (this.opening) return true;
    return this.surface.open && this.hiddenAtOpenRevision !== this.surface.openRevision;
  }

  private get available(): boolean {
    return this.joinAvailable || this.credentials.recovered;
  }

  private get canAttemptOpen(): boolean {
    return this.available
      || (!this.joinAvailable && this.joinDisabledReason === TEMPORARILY_DISABLED_REASON);
  }

  private get accessReady(): boolean {
    return this.credentials.isUsableFor(this.surface);
  }

  private hideLocally(): void {
    this.opening = false;
    this.hiddenAtOpenRevision = this.surface.openRevision;
    this.changed();
  }

  /** Close the gap between what should show and what does, then publish. */
  private changed(): void {
    if (this.active) {
      this.openOnStartIfDue();
      this.converge();
    }
    const next = this.buildSnapshot();
    if (shallowEqual(next, this.snapshot)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  /**
   * Revision 0 is the room saying "no one has decided yet". A negative
   * revision only means the join's view has not been confirmed by room
   * metadata, which is not the same thing, so it never triggers the open.
   */
  private openOnStartIfDue(): void {
    if (
      !this.options.openOnStart ||
      this.startOpenAttempted ||
      !this.canModerate ||
      !this.livekitConnected ||
      !this.canAttemptOpen ||
      this.surface.revision !== 0
    ) {
      return;
    }
    this.startOpenAttempted = true;
    this.openShared().catch(() => {
      // openShared has logged it; the Board view can still open it by hand.
    });
  }

  private converge(): void {
    const now = this.now();
    const wanted = this.locallyVisible && this.canAttemptOpen && this.surface.whiteboardId !== null;
    if (!wanted) {
      // Hidden, the canvas unmounts; shown again, it starts over.
      this.waitingSince = null;
      this.canvas = "loading";
      this.canvasLoadingSince = null;
      this.scheduleWake(null);
      return;
    }

    const wakes: number[] = [];
    if (this.accessReady) {
      this.waitingSince = null;
      const documentId = this.credentials.current?.documentId ?? null;
      if (documentId !== this.canvasDocumentId) {
        // A new board mounts a new canvas, which reports from the start.
        this.canvasDocumentId = documentId;
        this.canvas = "loading";
        this.canvasLoadingSince = null;
      }
      // Replace the credential ahead of its expiry; the canvas keeps the old
      // one until the new one arrives.
      const refreshAt = this.credentials.refreshAt;
      if (refreshAt !== null) {
        if (now >= refreshAt) this.mintWhenDue(now, wakes);
        else wakes.push(refreshAt);
      }
      // The canvas's own deadline: missing it means sync is still recovering.
      if (this.canvas === "loading") {
        this.canvasLoadingSince ??= now;
        wakes.push(this.canvasLoadingSince + CANVAS_READY_TIMEOUT_MS);
      }
    } else {
      // Minting needs a seated connection, which LiveKit's gives.
      if (!this.livekitConnected) {
        this.waitingSince = now;
      } else {
        this.waitingSince ??= now;
        this.mintWhenDue(now, wakes);
      }
      if (this.waitingSince !== null) wakes.push(this.waitingSince + ACCESS_FAILED_AFTER_MS);
    }
    // Only what is still ahead: a deadline already passed has been acted on,
    // and waking for it again would spin.
    const ahead = wakes.filter((at) => at > now);
    this.scheduleWake(ahead.length > 0 ? Math.min(...ahead) : null);
  }

  private mintWhenDue(now: number, wakes: number[]): void {
    if (this.credentials.minting) return;
    if (now < this.mintRetryAt) {
      wakes.push(this.mintRetryAt);
      return;
    }
    this.credentials.mint(this.surface.revision).then(
      () => {
        this.mintFailures = 0;
        this.mintRetryAt = 0;
      },
      (error: unknown) => {
        this.mintRetryAt = this.now() + MINT_RETRY_DELAYS_MS[Math.min(this.mintFailures, MINT_RETRY_DELAYS_MS.length - 1)];
        this.mintFailures += 1;
        this.options.logError("[whiteboard] Could not get whiteboard access", error);
        this.changed();
      },
    );
  }

  private scheduleWake(at: number | null): void {
    this.clearTimer();
    if (at === null || !this.active) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.changed();
    }, Math.max(0, at - this.now()));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private watchRoom(): void {
    const room = this.room;
    if (!room) {
      this.livekitConnected = false;
      return;
    }
    const sync = () => {
      const connected = room.state === ConnectionState.Connected;
      if (connected === this.livekitConnected) return;
      this.livekitConnected = connected;
      this.changed();
    };
    this.livekitConnected = room.state === ConnectionState.Connected;
    const events = [RoomEvent.Connected, RoomEvent.Disconnected, RoomEvent.Reconnecting, RoomEvent.Reconnected];
    for (const event of events) room.on(event, sync);
    this.stopWatchingRoom = () => {
      for (const event of events) room.off(event, sync);
    };
  }

  private buildSnapshot(): WhiteboardSessionSnapshot {
    const credential = this.credentials.current;
    const canAttemptOpen = this.canAttemptOpen;
    const visible = this.locallyVisible;
    const accessReady = this.accessReady;
    return {
      sharedSurfaceOpen: this.surface.open,
      locallyVisible: visible,
      view: this.viewFor(visible, accessReady),
      canAttemptOpen,
      disabledReason: canAttemptOpen ? null : this.joinDisabledReason,
      whiteboardId: this.surface.whiteboardId,
      documentId: accessReady ? credential?.documentId ?? null : null,
      documentTitle: credential?.documentTitle ?? null,
      accessReady,
      token: accessReady ? credential?.access.token ?? null : null,
      wsUrl: accessReady ? credential?.access.whiteboardUrl ?? null : null,
      canEdit: credential?.access.canEditWhiteboard ?? false,
      canManage: credential?.access.canManageWhiteboard ?? false,
    };
  }

  private viewFor(visible: boolean, accessReady: boolean): WhiteboardViewState {
    if (!visible) return "idle";
    if (!accessReady) {
      const waited = this.waitingSince !== null && this.now() - this.waitingSince >= ACCESS_FAILED_AFTER_MS;
      return waited && this.mintFailures > 0 ? "fatal" : "loading";
    }
    if (this.canvas === "loading") {
      const timedOut = this.canvasLoadingSince !== null && this.now() - this.canvasLoadingSince >= CANVAS_READY_TIMEOUT_MS;
      return timedOut ? "reconnecting" : "loading";
    }
    return this.canvas;
  }
}

function shallowEqual<T extends object>(a: T, b: T): boolean {
  for (const key of Object.keys(a) as Array<keyof T>) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

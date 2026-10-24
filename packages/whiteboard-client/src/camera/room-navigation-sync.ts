import { atom, computed, react, type Atom, type Computed } from "@tldraw/state";
import type { Editor } from "tldraw";
import {
  createRoomNavigation,
  ROOM_NAVIGATION_ID,
  type RoomNavigationRecord,
} from "@orbmeet/whiteboard-core/room-navigation";
import type { PageNavigator } from "../pages/page-navigator";
import type { WhiteboardPage } from "../pages/page-manager";
import { isPresenceOf } from "./whiteboard-follow";

/** Who this client is in the room's navigation. Changes as the room does. */
export interface RoomNavigationRole {
  myUserId: string | null;
  /** This client drives the room's navigation: the navigation controller, else a manager. */
  isPresenter: boolean;
  /**
   * The board follows a presenter at all. A Meeting's board does; a document
   * opened on its own is read by each person on their own, so nobody writes
   * the room's navigation and nobody follows it.
   */
  presents: boolean;
}

export interface RoomPresenter {
  userId: string;
  userName: string;
}

/**
 * The room's navigation, from this client's side: followed while someone
 * else presents, written while this client does.
 *
 * The navigation is a document record (`RoomNavigationRecord`), so the room's
 * sync does the work a publish protocol would otherwise have to: it is
 * ordered with the pages it names, applied atomically with a page added in
 * the same write, retried after a reconnect, and restored to a late joiner
 * with the rest of the board. What is left here is reading it and moving the
 * camera, and writing it when this client presents.
 */
export class RoomNavigationSync {
  /** The room's navigation as the document holds it; null before anyone has presented. */
  readonly record: Computed<RoomNavigationRecord | null>;
  /** Whether this reader goes where the presenter goes. The presenter has nobody to follow. */
  readonly following: Atom<boolean> = atom("whiteboard following", true);
  /** The presenter, while they are on the board and are not this client. */
  readonly presenter: Computed<RoomPresenter | null>;
  /** Whether this client's camera is being carried along by the presenter now. */
  readonly followingLive: Computed<boolean>;

  private readonly role: Atom<RoomNavigationRole>;
  /** Whether the room was roaming at the navigation this client last read. */
  private lastRoam = false;
  /** The presenter has been put on the room's page once since presenting began. */
  private presenterPlaced = false;
  /** This follower has been put on the presenter's page once: that first time, at once rather than gliding. */
  private followerPlaced = false;

  constructor(
    private readonly editor: Editor,
    private readonly navigator: PageNavigator,
    role: RoomNavigationRole,
    private readonly onPagePresented?: (pageId: string) => void,
  ) {
    this.role = atom("whiteboard navigation role", role);
    this.record = computed("whiteboard room navigation", () => editor.store.get(ROOM_NAVIGATION_ID) ?? null);
    this.presenter = computed("whiteboard presenter", () => {
      const presenterId = this.record.get()?.presenterId ?? null;
      if (!presenterId || presenterId === this.role.get().myUserId) return null;
      // A presenter whose session has left the board has no presence: there is
      // nobody to follow, and nobody to name.
      const presence = editor.getCollaborators().find((candidate) => isPresenceOf(candidate.userId, presenterId));
      return presence ? { userId: presenterId, userName: presence.userName } : null;
    });
    this.followingLive = computed("whiteboard following live", () => {
      const { presents, isPresenter } = this.role.get();
      return presents && !isPresenter && this.following.get() && this.presenter.get() !== null;
    });
  }

  setRole(role: RoomNavigationRole): void {
    const current = this.role.get();
    if (
      current.myUserId === role.myUserId &&
      current.isPresenter === role.isPresenter &&
      current.presents === role.presents
    ) {
      return;
    }
    if (!role.isPresenter) this.presenterPlaced = false;
    this.role.set(role);
  }

  /** The room's roam switch, as its presenter sees it. */
  get roam(): boolean {
    return this.record.get()?.roam ?? false;
  }

  start(): () => void {
    const { director } = this.navigator;
    const stops = [
      react("whiteboard roam", () => this.readRoam()),
      react("whiteboard follow the room", () => this.followRoom()),
      react("whiteboard present", () => this.present()),
      // A follower who moves the view is looking around on their own.
      director.onOwnMove(() => {
        if (this.followingLive.get()) this.stopFollowing();
      }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }

  /** Go where the presenter is again, and keep going with them. */
  follow(): void {
    this.following.set(true);
  }

  /** Stop going with the presenter; their page turns are no longer applied here. */
  stopFollowing(): void {
    this.following.set(false);
  }

  /** The presenter's: let everyone look around on their own, or carry them along again. */
  setRoam(roam: boolean): void {
    if (!this.isPresenting()) return;
    this.write({ roam });
  }

  /** The presenter's: make the page they are on the room's, now. */
  presentCurrentPage(): boolean {
    if (!this.isPresenting()) return false;
    const page = this.viewedPage();
    if (!page) return false;
    this.write({ pageId: page.id, pageNumber: page.number });
    return true;
  }

  // ─── Reactions ─────────────────────────────────────────────────────────

  /**
   * Letting everyone roam stops following; taking them back starts it again.
   * Only the change does: someone who stopped on their own during a
   * presentation is not pulled back by the presenter's next page turn.
   */
  private readRoam(): void {
    const roam = this.record.get()?.roam ?? false;
    if (roam === this.lastRoam) return;
    this.lastRoam = roam;
    if (!this.role.get().isPresenter) this.following.set(!roam);
  }

  /**
   * Hand the director whether it follows, then where to: in that order, in
   * one reaction, so following again lands on the presenter's page at once.
   * Not before the board has been placed: the first placement would put the
   * view back on the page this reader was on.
   */
  private followRoom(): void {
    const live = this.followingLive.get();
    this.navigator.director.setFollowing(live);
    if (!live || !this.navigator.initialCameraReady.get()) return;
    const record = this.record.get();
    if (!record?.pageId) return;
    const page = this.resolvePage(record);
    if (!page) return;
    this.navigator.director.follow(page.id, { pageNumber: page.number, animate: this.followerPlaced });
    this.followerPlaced = true;
  }

  /**
   * While this client presents, the page it is on is the room's. Taking up
   * presenting first puts this client on the room's page when the room has
   * one — a presenter who reloads comes back to where the room is, rather
   * than taking it back to the first page.
   */
  private present(): void {
    if (!this.isPresenting() || !this.navigator.initialCameraReady.get()) return;
    if (!this.presenterPlaced) {
      this.presenterPlaced = true;
      const record = this.editor.store.unsafeGetWithoutCapture(ROOM_NAVIGATION_ID);
      const roomPage = record?.pageId ? this.resolvePage(record) : null;
      if (roomPage && roomPage.id !== this.viewedPage()?.id) {
        this.navigator.changePageById(roomPage.id);
        return;
      }
    }
    const page = this.viewedPage();
    if (page) this.write({ pageId: page.id, pageNumber: page.number });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private isPresenting(): boolean {
    const { presents, isPresenter, myUserId } = this.role.get();
    return presents && isPresenter && myUserId !== null;
  }

  /**
   * The page this client's view names, once it is on the board. A view still
   * waiting for its page (one the room has just added) names none yet: the
   * page at its number meanwhile is a different page.
   */
  private viewedPage(): WhiteboardPage | null {
    const view = this.navigator.director.view.get();
    if (!view) return null;
    return this.navigator.pages.get().find((page) => page.id === view.pageId) ?? null;
  }

  /**
   * The page a navigation names: its frame, or — once that frame has been
   * deleted — the page now at the number it had. A navigation never arrives
   * ahead of its page: both travel in order on the room's sync.
   */
  private resolvePage(record: RoomNavigationRecord): WhiteboardPage | null {
    const pages = this.navigator.pages.get();
    if (pages.length === 0) return null;
    return (
      pages.find((page) => page.id === record.pageId) ??
      pages[Math.min(Math.max(1, record.pageNumber), pages.length) - 1] ??
      null
    );
  }

  /**
   * Write the room's navigation as this client. Outside history: presenting
   * is not something undo should take back. Roam is the presenter's call, so
   * a new presenter starts with everyone following.
   */
  private write(fields: Partial<Pick<RoomNavigationRecord, "pageId" | "pageNumber" | "roam">>): void {
    const { myUserId } = this.role.get();
    if (!myUserId) return;
    const current = this.editor.store.unsafeGetWithoutCapture(ROOM_NAVIGATION_ID) ?? createRoomNavigation();
    const next: RoomNavigationRecord = {
      ...current,
      roam: current.presenterId === myUserId ? current.roam : false,
      ...fields,
      presenterId: myUserId,
    };
    if (
      next.pageId === current.pageId &&
      next.pageNumber === current.pageNumber &&
      next.presenterId === current.presenterId &&
      next.roam === current.roam
    ) {
      return;
    }
    this.editor.run(() => this.editor.store.put([next]), { history: "ignore" });
    if (next.pageId && next.pageId !== current.pageId) this.onPagePresented?.(next.pageId);
  }
}

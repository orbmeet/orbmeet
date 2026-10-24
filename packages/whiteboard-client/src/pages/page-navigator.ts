import { atom, computed, type Atom, type Computed } from "@tldraw/state";
import type { Editor, TLShapeId } from "tldraw";
import { CameraConstraints } from "../camera/camera-constraints";
import { CameraDirector } from "../camera/camera-director";
import { PageManager, type WhiteboardPage } from "./page-manager";
import type { WhiteboardChromeConfig } from "../chrome/whiteboard-chrome";
import { arePagesEqual } from "./whiteboard-page-state";
import { changeTouchesPageFrames } from "@orbmeet/whiteboard-core/page-frame-model";

export interface PageNavigatorOptions {
  chrome: WhiteboardChromeConfig;
  canManagePages: boolean;
  canAutoCreatePages: boolean;
  /** The page to restore on the first fit: where the viewer was on the previous editor. */
  startPage?: number;
}

/**
 * The board's pages and the camera over them, for one editor.
 *
 * Owns the page model (`PageManager`), the camera geometry
 * (`CameraConstraints`) and the camera itself (`CameraDirector`), and turns
 * what the reader and the room ask for — a page, a presenter's view, a new
 * page — into a view for the director to show. What the UI renders — pages,
 * the current page, zoom, whether the board has been placed — are atoms, read
 * with `useValue`.
 */
export class PageNavigator {
  readonly pageManager: PageManager;
  readonly cameraConstraints: CameraConstraints;
  readonly director: CameraDirector;
  readonly pages: Atom<WhiteboardPage[]> = atom("whiteboard pages", [], { isEqual: arePagesEqual });
  /** The zoom control's reading: null while the reader has not zoomed (each page fitted), else a percentage. */
  readonly zoomPercent: Computed<number | null> = computed("whiteboard zoom percent", () => this.director.zoomPercent());
  /** The board has been placed on its first page; until then the host shows it loading. */
  readonly initialCameraReady: Atom<boolean> = atom("whiteboard initial camera ready", false);

  private canManagePages: boolean;
  private chrome: WhiteboardChromeConfig;
  private canAutoCreatePages: boolean;
  private syncReady = false;
  /** The page the first placement after a sync (re)start lands on. */
  private restoredPageValue: number;
  private hasInitialized = false;

  constructor(
    private readonly editor: Editor,
    options: PageNavigatorOptions,
  ) {
    this.canManagePages = options.canManagePages;
    this.chrome = options.chrome;
    this.canAutoCreatePages = options.canAutoCreatePages;
    this.restoredPageValue = options.startPage ?? 1;
    this.cameraConstraints = new CameraConstraints(editor, undefined, options.chrome);
    this.cameraConstraints.setCanAutoCreate(options.canAutoCreatePages);
    this.pageManager = new PageManager(editor, undefined, () => this.cameraConstraints.getVisibleViewportBounds());
    this.director = new CameraDirector(
      editor,
      this.cameraConstraints,
      {
        getPages: () => this.pages.get(),
        getChrome: () => this.chrome,
      },
      this.restoredPageValue,
    );
  }

  /** The page the board is on. */
  get currentPage(): Atom<number> {
    return this.director.currentPage;
  }

  /** Where the viewer is, to carry over to the next editor's navigator. */
  get restoredPage(): number {
    return this.initialCameraReady.get() ? this.director.currentPage.get() : this.restoredPageValue;
  }

  /** Remember where the viewer is before the board stops being placed. */
  private rememberPage(): void {
    if (this.initialCameraReady.get()) this.restoredPageValue = this.director.currentPage.get();
  }

  // ─── Lifetime ──────────────────────────────────────────────────────────

  /** Install the listeners that keep pages and camera in step. Returns their teardown. */
  start(): () => void {
    this.readPages();
    const stops = [
      this.cameraConstraints.install(),
      this.director.start(),
      this.watchPages(),
    ];
    this.placeInitially();
    return () => {
      this.rememberPage();
      for (const stop of stops) stop();
      this.initialCameraReady.set(false);
    };
  }

  /** Read at placement time and by the page actions; changing it moves nothing. */
  setCanManagePages(canManagePages: boolean): void {
    this.canManagePages = canManagePages;
  }

  /** The chrome or page-creation permission changed: the board's geometry may have too. */
  configure(options: Pick<PageNavigatorOptions, "chrome" | "canAutoCreatePages">): void {
    if (options.chrome === this.chrome && options.canAutoCreatePages === this.canAutoCreatePages) return;
    this.chrome = options.chrome;
    this.canAutoCreatePages = options.canAutoCreatePages;
    this.cameraConstraints.setCanAutoCreate(options.canAutoCreatePages);
    this.director.syncGeometry();
    this.director.pagesChanged();
  }

  /** Sync became ready (or stopped being). The board is placed on its page once it is. */
  setSyncReady(ready: boolean): void {
    this.rememberPage();
    this.syncReady = ready;
    this.initialCameraReady.set(false);
    this.placeInitially();
  }

  /**
   * The first placement: once sync is ready and there are pages, the board is
   * on the restored page. Nothing waits for the container to stop resizing —
   * the director re-places the page every time the board changes size, so a
   * meeting shell still animating the board open just carries the page with
   * it.
   */
  private placeInitially(): void {
    if (!this.syncReady || this.initialCameraReady.get()) return;
    // Only a write-capable client creates the first page; readonly
    // participants render the frames once the host's document arrives.
    if (this.canManagePages && this.pageManager.getPages().length === 0 && !this.hasInitialized) {
      this.hasInitialized = true;
      this.pageManager.initialize();
      this.readPages();
    }
    const pages = this.pages.get();
    if (pages.length === 0) return;
    const page = pages[Math.min(Math.max(1, this.restoredPageValue), pages.length) - 1];
    this.director.go({ kind: "page", pageId: page.id }, { animate: false });
    this.initialCameraReady.set(true);
  }

  // ─── Listeners ─────────────────────────────────────────────────────────

  /** Read the page list; tell the director when it changed. Returns whether it did. */
  private readPages(): boolean {
    const next = this.pageManager.getPages();
    if (arePagesEqual(this.pages.get(), next)) return false;
    this.pages.set(next);
    this.director.pagesChanged();
    return true;
  }

  /**
   * Re-read the pages when a committed change touches a page frame, and only
   * then: the change says which records it touched, so a stroke's traffic —
   * every point a document change — costs a look at its own records, not a
   * walk over every shape on the board.
   */
  private watchPages(): () => void {
    return this.editor.store.listen(
      ({ changes }) => {
        if (!changeTouchesPageFrames(changes)) return;
        this.readPages();
        this.placeInitially();
      },
      { scope: "document" },
    );
  }

  // ─── Navigation ────────────────────────────────────────────────────────

  private goToPage(page: WhiteboardPage, animate = true): void {
    this.director.go({ kind: "page", pageId: page.id }, { animate });
  }

  changePage(pageNumber: number): void {
    const pages = this.pages.get();
    const page = pages[Math.min(Math.max(1, pageNumber), pages.length) - 1];
    if (page) this.goToPage(page);
  }

  /**
   * Go to a page this client's own action put on the board (a page the room
   * added for it, an import), whether or not it has synced in yet: the board
   * waits for it, already counting from `pageNumber`.
   */
  showPage(pageId: string, pageNumber: number): void {
    this.director.go({ kind: "page", pageId }, { pageNumber });
  }

  changePageById(pageId: TLShapeId): boolean {
    const page = this.pages.get().find((candidate) => candidate.id === pageId);
    if (!page) return false;
    this.goToPage(page);
    return true;
  }

  zoomIn(): void {
    this.director.zoomIn();
  }

  zoomOut(): void {
    this.director.zoomOut();
  }

  /** Back to the fit, around what is in the middle of the screen now. */
  resetView(): void {
    this.director.fit();
  }

  // ─── Page actions ──────────────────────────────────────────────────────

  /** Append a page and move to it. Null when this client may not manage pages. */
  addPage(): WhiteboardPage | null {
    if (!this.canManagePages) return null;
    const createdId = this.pageManager.createPage();
    if (!createdId) return null;
    this.readPages();
    const pages = this.pages.get();
    const created = pages.find((page) => page.id === createdId) ?? pages[pages.length - 1] ?? null;
    if (created) this.goToPage(created);
    return created;
  }

  /** Insert a blank page right after `afterPageNumber` and move to it. */
  insertPageAfter(afterPageNumber: number): WhiteboardPage | null {
    if (!this.canManagePages) return null;
    // insertPagesAt(index) inserts before position `index` in the sorted
    // array, so a 1-based page number puts the new page right after it.
    const inserted = this.pageManager.insertPagesAt(afterPageNumber, 1);
    if (inserted.length === 0) return null;
    this.readPages();
    const insertedPage = this.pages.get().find((page) => page.id === inserted[0]) ?? null;
    if (insertedPage) this.goToPage(insertedPage);
    return insertedPage;
  }

  insertPageAfterCurrent(): WhiteboardPage | null {
    return this.insertPageAfter(this.director.currentPage.get());
  }

  /** Re-read pages after a change made outside the navigator (an import, a clear). */
  onPagesChanged(): void {
    this.readPages();
  }

  commitDeletePage(pageId: TLShapeId): void {
    const pages = this.pages.get();
    const deleted = pages.find((page) => page.id === pageId);
    if (!deleted) return;
    const current = this.director.currentPage.get();
    if (!this.pageManager.deletePage(pageId)) return;
    this.readPages();
    const next = this.pages.get();
    if (next.length === 0) return;
    // The page before stays where it was; one after it moves up by one; the
    // deleted one gives way to whichever page took its number.
    const target = deleted.number < current ? current - 1 : current;
    this.goToPage(next[Math.min(Math.max(1, target), next.length) - 1]);
  }
}

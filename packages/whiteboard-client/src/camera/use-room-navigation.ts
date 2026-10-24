import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useValue, type Editor } from "tldraw";
import type { PageTarget } from "@orbmeet/whiteboard-core/sync-commands";
import { useCommittedRef } from "@orbmeet/ui/react";
import type { PageNavigator } from "../pages/page-navigator";
import { RoomNavigationSync, type RoomNavigationRole } from "./room-navigation-sync";
import { selectWhiteboardFollowState, type WhiteboardFollowState } from "./whiteboard-follow";

/** Who this participant follows, and the page they are on, for questions to the assistant. */
export interface FollowedPresenter {
  presenterName: string;
  pageNumber: number;
}

interface RoomNavigationOptions extends RoomNavigationRole {
  editor: Editor | null;
  navigator: PageNavigator | null;
  /** A page this client has just made the room's, for the host to record. */
  onPagePresented?: (pageId: string) => void;
  onFollowStateChange?: (state: WhiteboardFollowState | null) => void;
}

export interface RoomNavigation {
  followState: WhiteboardFollowState | null;
  /** The presenter's "let everyone look around" switch, while someone else is on the board. */
  presenting: { roam: boolean; onToggleRoam: () => void } | null;
  /** This participant's own page turn: the room's if they present, a step off the presenter if they follow. */
  turnPage: (pageNumber: number) => void;
  /** A follower who looks somewhere on their own stops following. */
  stopFollowingOnOwnMove: () => void;
  /** Go to a page this participant's own action added. */
  showOwnPage: (page: PageTarget) => void;
  /** Presenter-only: make the page they are on the room's, now. */
  presentCurrentPage: () => boolean;
  followedPresenterRef: RefObject<FollowedPresenter | null>;
}

/** The room's navigation for one board: followed while someone else presents, written while this participant does. */
export function useRoomNavigation({
  editor,
  navigator,
  myUserId,
  isPresenter,
  presents,
  onPagePresented,
  onFollowStateChange,
}: RoomNavigationOptions): RoomNavigation {
  const roleRef = useCommittedRef<RoomNavigationRole>({ myUserId, isPresenter, presents });
  const onPagePresentedRef = useCommittedRef(onPagePresented);
  const [sync, setSync] = useState<RoomNavigationSync | null>(null);

  useEffect(() => {
    if (!editor || !navigator) return;
    const next = new RoomNavigationSync(editor, navigator, roleRef.current, (pageId) =>
      onPagePresentedRef.current?.(pageId),
    );
    setSync(next);
    const stop = next.start();
    return () => {
      stop();
      setSync(null);
    };
  }, [editor, navigator, onPagePresentedRef, roleRef]);

  useEffect(() => {
    sync?.setRole({ myUserId, isPresenter, presents });
  }, [sync, myUserId, isPresenter, presents]);

  const following = useValue("whiteboard following", () => sync?.following.get() ?? true, [sync]);
  const presenter = useValue("whiteboard presenter", () => sync?.presenter.get() ?? null, [sync]);
  const roam = useValue("whiteboard roam", () => sync?.roam ?? false, [sync]);
  const followedPageNumber = useValue(
    "whiteboard followed page",
    () => {
      const pageId = sync?.record.get()?.pageId;
      if (!pageId || !navigator) return null;
      const page = navigator.pages.get().find((candidate) => candidate.id === pageId);
      return page?.number ?? null;
    },
    [navigator, sync],
  );
  const othersOnBoard = useValue("others on the board", () => editor?.getCollaborators().length ?? 0, [editor]);

  const follow = useCallback(() => sync?.follow(), [sync]);
  const stopFollowing = useCallback(() => sync?.stopFollowing(), [sync]);

  const followState = useMemo(
    () =>
      presents
        ? selectWhiteboardFollowState({
            isPresenter,
            myUserId,
            presenterId: presenter?.userId ?? null,
            presenterName: presenter?.userName ?? null,
            following,
            roam,
            follow,
            stopFollowing,
          })
        : null,
    [follow, following, isPresenter, myUserId, presenter, presents, roam, stopFollowing],
  );
  const notifyFollowState = useEffectEvent((state: WhiteboardFollowState | null) => {
    onFollowStateChange?.(state);
  });
  useEffect(() => {
    notifyFollowState(followState);
  }, [followState]);
  // The host must not keep offering to follow a presenter on a board that is gone.
  useEffect(() => () => notifyFollowState(null), []);

  const followedPresenterRef = useRef<FollowedPresenter | null>(null);
  useLayoutEffect(() => {
    followedPresenterRef.current =
      followState?.following && followedPageNumber !== null
        ? { presenterName: followState.presenterName, pageNumber: followedPageNumber }
        : null;
  }, [followState, followedPageNumber]);

  const stopFollowingOnOwnMove = useCallback(() => {
    if (sync?.followingLive.get()) sync.stopFollowing();
  }, [sync]);

  const turnPage = useCallback(
    (pageNumber: number) => {
      stopFollowingOnOwnMove();
      navigator?.changePage(pageNumber);
    },
    [navigator, stopFollowingOnOwnMove],
  );

  const showOwnPage = useCallback(
    (page: PageTarget) => navigator?.showPage(page.pageId, page.pageNumber),
    [navigator],
  );

  const presentCurrentPage = useCallback(() => sync?.presentCurrentPage() ?? false, [sync]);

  const toggleRoam = useCallback(() => sync?.setRoam(!roam), [roam, sync]);
  const presenting = useMemo(
    () => (presents && isPresenter && othersOnBoard > 0 ? { roam, onToggleRoam: toggleRoam } : null),
    [isPresenter, othersOnBoard, presents, roam, toggleRoam],
  );

  return {
    followState,
    presenting,
    turnPage,
    stopFollowingOnOwnMove,
    showOwnPage,
    presentCurrentPage,
    followedPresenterRef,
  };
}

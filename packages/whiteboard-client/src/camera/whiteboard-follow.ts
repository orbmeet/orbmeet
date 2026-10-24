/**
 * What the board says about following the presenter, and the two things a
 * follower can do about it.
 *
 * Everyone who is not presenting follows the presenter's page. That is
 * the behaviour a class or a review needs, and it was silent: nothing on
 * screen said whose view you were being carried along by, and nothing let
 * you look back at an earlier page without being pulled away again on the
 * presenter's next move. This is the state that makes it visible and
 * reversible.
 */
export interface WhiteboardFollowState {
  presenterName: string;
  following: boolean;
  /** The presenter has let everyone look around on their own. */
  roam: boolean;
  follow: () => void;
  stopFollowing: () => void;
}

export function selectWhiteboardFollowState({
  isPresenter,
  myUserId,
  presenterId,
  presenterName,
  following,
  roam = false,
  follow,
  stopFollowing,
}: {
  /** This client drives the room's navigation; it has nobody to follow. */
  isPresenter: boolean;
  myUserId: string | null;
  /** Who last moved the room's navigation. */
  presenterId: string | null;
  /** Their display name, once their presence has arrived. */
  presenterName: string | null;
  following: boolean;
  roam?: boolean;
  follow: () => void;
  stopFollowing: () => void;
}): WhiteboardFollowState | null {
  if (isPresenter || !presenterId || presenterId === myUserId) return null;
  // A presenter with no presence (they left, or have not synced yet) cannot
  // be named, and "Following someone" is worse than saying nothing.
  const name = presenterName?.trim();
  if (!name) return null;
  return { presenterName: name, following, roam, follow, stopFollowing };
}

/**
 * Whether a presence record belongs to a user.
 *
 * tldraw keys presence by record id — `user:<id>` — while the navigation's
 * `presenterId` is the bare id the server knows the connection by. Compared
 * directly the two never match, and the presenter is never named.
 */
export function isPresenceOf(presenceUserId: string, userId: string): boolean {
  return presenceUserId === userId || presenceUserId === `user:${userId}`;
}


import { atom, transact, type Atom } from "@tldraw/state";
import { getDefaultUserPresence, type TLStore, type TLUser } from "tldraw";

/**
 * How long a cursor lingers after someone stops working.
 *
 * Long enough that lifting the pen between two strokes of the same letter does
 * not make your cursor blink out of the room, short enough that a cursor left
 * parked on the board is not a live feed of where you are looking.
 */
export const PRESENCE_LINGER_MS = 1_500;

/**
 * The presence `meta` key that carries how many times the room has asked this
 * client to resync its presence. Bumping it is a presence change, and the
 * room forwards the next change of a session it has fallen out of step with
 * whole (see the room's presence lane), so every peer is back in step.
 */
export const PRESENCE_RESYNC_META_KEY = "orbmeetPresenceResync";

export interface PresenceActivity {
  /** True while this client should be broadcasting a cursor. */
  readonly active: Atom<boolean, unknown>;
  /** How many times the room has asked for a resync (`PRESENCE_RESYNC_META_KEY`). */
  readonly resyncs: Atom<number, unknown>;
  /**
   * When this client last went quiet, or null if it never was active. A quiet
   * presence reports this as its activity time, so moving a pointer over the
   * board without drawing does not keep announcing that its owner is there.
   */
  readonly quietSince: Atom<number | null, unknown>;
  /** Pointer went down: the user is working. */
  begin(): void;
  /** Pointer came up: start the linger, then go quiet. */
  end(): void;
  /** The room fell out of step with this client's presence: send it again. */
  resync(): void;
  dispose(): void;
}

/**
 * Whether this client is currently doing something worth showing the room.
 *
 * A resting cursor is a live feed of where its owner is looking, broadcast to
 * everyone on the board — and until now that included people who cannot draw
 * on it at all, since presence is a different record type from document writes
 * and the server's edit check only ever covered the latter. A viewer reading
 * quietly was telling the room which paragraph they were on.
 *
 * It also produced the visible bug: a cursor renders wherever the pointer is
 * in page space, desk included, so a parked pointer drew a coloured arrow
 * below the page with nothing to explain it.
 *
 * So presence is tied to activity rather than to permission. Pointer down and
 * the room sees you; a beat after pointer up and it does not. Nobody has a
 * resting cursor, which is both the private answer and — because a parked
 * pointer no longer broadcasts at all — the one that removes the stray mark.
 *
 * This is an `atom` rather than a ref because `getUserPresence` runs inside a
 * reactive derivation: a plain boolean would be read once and never re-read.
 */
export function createPresenceActivity(): PresenceActivity {
  const active = atom<boolean>("whiteboard-presence-active", false);
  const resyncs = atom<number>("whiteboard-presence-resyncs", 0);
  const quietSince = atom<number | null>("whiteboard-presence-quiet-since", null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    active,
    resyncs,
    quietSince,
    begin() {
      clear();
      active.set(true);
    },
    end() {
      clear();
      timer = setTimeout(() => {
        timer = undefined;
        transact(() => {
          quietSince.set(Date.now());
          active.set(false);
        });
      }, PRESENCE_LINGER_MS);
    },
    resync() {
      resyncs.set(resyncs.get() + 1);
    },
    dispose() {
      clear();
      if (active.get()) quietSince.set(Date.now());
      active.set(false);
    },
  };
}

/**
 * The `getUserPresence` implementation: tldraw's own presence while the user is
 * working, and an explicitly inactive record otherwise.
 *
 * tldraw does not emit a remove operation when this callback changes from a
 * presence record to `null`, so returning null here would leave the last active
 * record frozen on every peer. Patch every visible/activity-bearing field to
 * its inactive value instead.
 */
export function presenceWhileActive(
  activity: PresenceActivity,
  store: TLStore,
  user: TLUser,
) {
  const presence = getDefaultUserPresence(store, user);
  if (!presence) return presence;
  const active = activity.active.get();
  const resyncs = activity.resyncs.get();
  const meta = resyncs > 0 ? { [PRESENCE_RESYNC_META_KEY]: resyncs } : {};
  if (active) return { ...presence, meta };
  return {
    ...presence,
    cursor: null,
    camera: null,
    screenBounds: null,
    selectedShapeIds: [],
    brush: null,
    scribbles: [],
    followingUserId: null,
    chatMessage: "",
    lastActivityTimestamp: activity.quietSince.get(),
    meta,
  };
}

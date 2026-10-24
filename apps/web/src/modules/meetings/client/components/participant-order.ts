import { Track, type Participant } from "livekit-client";
import type { TrackReference } from "@livekit/components-react";

/**
 * Composable ordering primitives for the video layout.
 *
 * The layout ranks participants and tracks in several places (sidebar avatars,
 * mobile grid, pinned stage, screen-share rail). Those orderings are NOT the
 * same — some put the local user first, others last; some rank hosts or a
 * pinned/primary tile, others don't — so they cannot collapse into a single
 * comparator. What they *did* share was a hand-rolled tier of
 * `const aX = …?1:0; const bX = …; if (aX !== bX) return …` blocks, written
 * inconsistently (`?1:0` here, early-return booleans there) and drifting.
 *
 * These primitives are that shared tier, expressed once. Each call site now
 * declares its ordering as a composition, so the intent is legible and the two
 * representations (LiveKit `TrackReference` vs `Participant`) reuse the same
 * building blocks.
 */

export type Comparator<T> = (a: T, b: T) => number;

/** Compose comparators left-to-right; the first non-zero result wins. */
export function chainComparators<T>(...comparators: Comparator<T>[]): Comparator<T> {
  return (a, b) => {
    for (const compare of comparators) {
      const result = compare(a, b);
      if (result !== 0) return result;
    }
    return 0;
  };
}

/** Order entries for which `flag` is true ahead of the rest. */
export function preferFlag<T>(flag: (x: T) => boolean): Comparator<T> {
  return (a, b) => (flag(b) ? 1 : 0) - (flag(a) ? 1 : 0);
}

/** Order entries for which `flag` is true behind the rest. */
export function deferFlag<T>(flag: (x: T) => boolean): Comparator<T> {
  return (a, b) => (flag(a) ? 1 : 0) - (flag(b) ? 1 : 0);
}

/** Alphabetical by a string label (locale-aware). */
export function byLabel<T>(label: (x: T) => string): Comparator<T> {
  return (a, b) => label(a).localeCompare(label(b));
}

// ─── Shape accessors ────────────────────────────────────────────────────────
// Context-free flags/labels for the two shapes ordered here. Context-dependent
// flags (host via a connections map, pinned/primary via an id) stay inline at the
// call site, where the context is in scope.

export const isScreenShareTrack = (t: TrackReference): boolean =>
  t.source === Track.Source.ScreenShare;

export const isLocalTrack = (t: TrackReference): boolean =>
  Boolean(t.participant?.isLocal);

export const trackLabel = (t: TrackReference): string =>
  t.participant?.name || t.participant?.identity || "";

export const isLocalParticipant = (p: Participant): boolean => p.isLocal;

export const participantLabel = (p: Participant): string =>
  p.name || p.identity || "";

/**
 * The order of the faces in the room column, as data.
 *
 * The column scrolls, so in a big room someone talking can be out of view.
 * They come up — but without a shuffle. Reordering everyone by who spoke last
 * moves every tile on every sentence; here one person comes in and one goes
 * out, and only when it is worth it:
 *
 * - Someone already in view never moves, however much they talk.
 * - Someone out of view who is talking swaps places with whoever in view has
 *   been quiet the longest. Two tiles change; the rest stay where they were.
 * - You stay where you are: your own tile is how you find your place.
 * - At most one swap per {@link SWAP_COOLDOWN_MS}, so two people trading
 *   turns cannot make the column flicker.
 *
 * Pure, so the rule is tested without a room.
 */

/** The shortest time between two swaps. */
export const SWAP_COOLDOWN_MS = 4_000;

/**
 * How long someone must have been talking before they are brought into view:
 * a cough or a "mm" is not a turn.
 */
export const SUSTAINED_SPEECH_MS = 1_200;

export interface SpeakerOrderInput {
  /** The order shown last time. */
  order: readonly string[];
  /** Everyone in the column now, in the order a newcomer should take. */
  present: readonly string[];
  /** Who is talking now, with when they started. */
  speakingSince: ReadonlyMap<string, number>;
  /** When each person last spoke; absent for someone who has not. */
  lastSpokeAt: ReadonlyMap<string, number>;
  /** How many tiles fit in view from the top. */
  inView: number;
  /** Never moved by speech: you. */
  fixed: ReadonlySet<string>;
  now: number;
  /** When the last swap happened; 0 for never. */
  lastSwapAt: number;
}

export interface SpeakerOrder {
  order: string[];
  /** Who was just brought into view, or null when nothing moved. */
  swappedIn: string | null;
}

/** Keeps the people still here where they were, and adds newcomers at the end. */
export function reconcileOrder(order: readonly string[], present: readonly string[]): string[] {
  const here = new Set(present);
  const kept = order.filter((id) => here.has(id));
  const known = new Set(kept);
  return [...kept, ...present.filter((id) => !known.has(id))];
}

export function nextSpeakerOrder(input: SpeakerOrderInput): SpeakerOrder {
  const order = reconcileOrder(input.order, input.present);
  const inView = Math.max(0, Math.min(input.inView, order.length));
  if (inView === 0 || inView === order.length) return { order, swappedIn: null };
  if (input.lastSwapAt > 0 && input.now - input.lastSwapAt < SWAP_COOLDOWN_MS) {
    return { order, swappedIn: null };
  }

  // The longest-running turn out of view comes in first.
  const comingIn = order
    .slice(inView)
    .filter((id) => {
      const since = input.speakingSince.get(id);
      return since !== undefined && input.now - since >= SUSTAINED_SPEECH_MS;
    })
    .sort((a, b) => input.speakingSince.get(a)! - input.speakingSince.get(b)!)[0];
  if (!comingIn) return { order, swappedIn: null };

  // Out goes whoever in view has been quiet the longest — never you, and
  // never someone talking. On a tie, the one nearest the bottom moves.
  let goingOut = -1;
  let quietSince = Infinity;
  for (let index = inView - 1; index >= 0; index--) {
    const id = order[index];
    if (input.fixed.has(id) || input.speakingSince.has(id)) continue;
    const spoke = input.lastSpokeAt.get(id) ?? -Infinity;
    if (spoke < quietSince) {
      quietSince = spoke;
      goingOut = index;
    }
  }
  if (goingOut < 0) return { order, swappedIn: null };

  const from = order.indexOf(comingIn);
  const next = [...order];
  next[goingOut] = comingIn;
  next[from] = order[goingOut];
  return { order: next, swappedIn: comingIn };
}

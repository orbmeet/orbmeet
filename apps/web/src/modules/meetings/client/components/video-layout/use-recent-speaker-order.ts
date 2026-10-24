import { useEffect, useMemo, useRef, useState } from "react";
import { nextSpeakerOrder, reconcileOrder } from "@/modules/meetings/client/speaker-order";

/** How often to look again while someone is talking: a turn becomes sustained, a cooldown ends. */
const RECHECK_MS = 500;

/**
 * The column's order, following who talks without shuffling: see
 * `nextSpeakerOrder` for the rule. Returns the ids in the order to show, and
 * who was just brought into view (for one entrance, not a reflow).
 */
export function useRecentSpeakerOrder({
  present,
  speaking,
  inView,
  fixed,
}: {
  present: readonly string[];
  speaking: readonly string[];
  inView: number;
  fixed: readonly string[];
}): { order: string[]; swappedIn: string | null } {
  const [state, setState] = useState<{ order: string[]; swappedIn: string | null }>(() => ({
    order: [...present],
    swappedIn: null,
  }));
  const [recheck, setRecheck] = useState(0);
  const speakingSince = useRef(new Map<string, number>());
  const lastSpokeAt = useRef(new Map<string, number>());
  const lastSwapAt = useRef(0);

  // The same people in a new array is no change: work from their ids.
  const presentIds = useIds(present);
  const speakingIds = useIds(speaking);
  const fixedIds = useIds(fixed);

  useEffect(() => {
    const now = Date.now();
    const talking = new Set(speakingIds);
    for (const id of speakingSince.current.keys()) {
      if (!talking.has(id)) speakingSince.current.delete(id);
    }
    for (const id of talking) {
      if (!speakingSince.current.has(id)) speakingSince.current.set(id, now);
      lastSpokeAt.current.set(id, now);
    }
    setState((current) => {
      const next = nextSpeakerOrder({
        order: current.order,
        present: presentIds,
        speakingSince: speakingSince.current,
        lastSpokeAt: lastSpokeAt.current,
        inView,
        fixed: new Set(fixedIds),
        now,
        lastSwapAt: lastSwapAt.current,
      });
      if (next.swappedIn) lastSwapAt.current = now;
      const unchanged =
        next.swappedIn === null &&
        next.order.length === current.order.length &&
        next.order.every((id, index) => id === current.order[index]);
      return unchanged ? current : next;
    });
  }, [presentIds, speakingIds, fixedIds, inView, recheck]);

  const anyoneTalking = speakingIds.length > 0;
  useEffect(() => {
    if (!anyoneTalking) return;
    const timer = setInterval(() => setRecheck((count) => count + 1), RECHECK_MS);
    return () => clearInterval(timer);
  }, [anyoneTalking]);

  return { order: reconcileOrder(state.order, presentIds), swappedIn: state.swappedIn };
}

/** An array that changes identity only when the ids in it change. */
function useIds(ids: readonly string[]): readonly string[] {
  const key = ids.join("\u0000");
  return useMemo(() => (key ? key.split("\u0000") : []), [key]);
}

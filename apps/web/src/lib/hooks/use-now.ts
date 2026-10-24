import { useEffect, useState } from "react";

/**
 * Returns a `Date.now()` value that updates on an interval, so components that
 * render relative timestamps ("12s ago", "5 min") stay accurate instead of
 * freezing at the value captured on first render. Pass `enabled={false}` to
 * stop the ticker when there's nothing time-sensitive on screen.
 */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);

  return now;
}

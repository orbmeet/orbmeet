import * as React from "react";

/**
 * `active`, but only once it has stayed true for `delayMs` — and false the
 * moment it turns false. For a state that is worth showing only when it
 * persists, such as a reconnect that a brief network blip would otherwise
 * flash on screen.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = React.useState(false);
  React.useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => {
      clearTimeout(timer);
      setElapsed(false);
    };
  }, [active, delayMs]);
  return active && elapsed;
}

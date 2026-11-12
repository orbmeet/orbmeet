export function isPageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * Runs `run` once the page shows: now if it does, otherwise when it next
 * becomes visible. A phone refuses capture to a page in the background, and a
 * rejoin often runs there. Returns a function that cancels a pending run.
 */
export function whenPageVisible(run: () => void): () => void {
  if (isPageVisible()) {
    run();
    return () => {};
  }
  const handleVisibilityChange = () => {
    if (!isPageVisible()) return;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    run();
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
}

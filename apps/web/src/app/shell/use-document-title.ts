import { useEffect } from "react";

/**
 * Own `document.title` for as long as this component is mounted, restoring the
 * previous value on unmount.
 *
 * Routes normally set their title through `head()`, but a route whose screen
 * changes underneath a single head — `/$code` is join screen, live room, and
 * "meeting ended" — cannot. `/$code` declared "Join Meeting — Orb Meet" once and
 * kept it for the whole session, so a tab sitting in a live meeting, and a tab
 * showing a meeting that had already ended, both still claimed to be a join
 * screen. With several meeting tabs open none of them could be told apart.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

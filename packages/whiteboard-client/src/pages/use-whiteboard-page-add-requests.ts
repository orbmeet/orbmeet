import { useCallback, useEffect, useRef, useState } from "react";
import { emitWhiteboardError } from "../chrome/whiteboard-error-event";

export type AddWhiteboardPageTarget = { afterPageNumber?: number };
export type AddWhiteboardPageFn = (target?: AddWhiteboardPageTarget) => Promise<unknown>;

const PAGE_ADD_TIMEOUT_MS = 12_000;

interface UseWhiteboardPageAddRequestsOptions {
  canManagePages: boolean;
  syncReady: boolean;
  onAddPage?: AddWhiteboardPageFn;
  applyAddedPageResponse: (response: unknown) => void;
  addPageLocally: () => void;
  insertPageAfterLocally: (afterPageNumber: number) => void;
}

interface UseWhiteboardPageAddRequestsReturn {
  isAddingPage: boolean;
  addPage: () => void;
  insertPageAfter: (afterPageNumber: number) => void;
}

/**
 * `undefined` means "append"; a number means "insert after page n".
 *
 * Zero is a real position — insert *before page 1* — and the authoritative
 * side has always accepted it (`z.number().int().min(0)` on the action,
 * `Math.max(0, …)` in the room). This clamped to 1, so the client could not
 * ask for the one position the rail now offers a control for. The floor is 0.
 */
export function normalizePageAddTarget(
  target?: AddWhiteboardPageTarget
): AddWhiteboardPageTarget | undefined {
  if (typeof target?.afterPageNumber !== "number" || !Number.isFinite(target.afterPageNumber)) {
    return undefined;
  }
  return { afterPageNumber: Math.max(0, Math.trunc(target.afterPageNumber)) };
}

/**
 * Whether the server provably never applied the page add, so creating the page
 * locally cannot duplicate it.
 *
 * A *timeout* deliberately does not qualify. It is the one failure mode where
 * the authoritative transaction most likely did commit and only the response was
 * lost, so falling back locally would sync a second frame into the same
 * document and leave the user with two pages. Every message below is a definite
 * rejection from a reachable server: the room is gone, or it does not consider
 * this caller a live participant.
 */
export function isRecoverablePageAddError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("resource not found") ||
    normalized.includes("room not found") ||
    normalized.includes("only connected meeting participants")
  );
}

/** A request that stalled: whether it committed server-side is unknowable here. */
export function isAmbiguousPageAddError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("timed out");
}

export function withPageAddTimeout<T>(
  promise: Promise<T>,
  timeoutMs = PAGE_ADD_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Whiteboard page add timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}

export function useWhiteboardPageAddRequests({
  canManagePages,
  syncReady,
  onAddPage,
  applyAddedPageResponse,
  addPageLocally,
  insertPageAfterLocally,
}: UseWhiteboardPageAddRequestsOptions): UseWhiteboardPageAddRequestsReturn {
  const [isAddingPage, setIsAddingPage] = useState(false);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const requestAddPage = useCallback((target?: AddWhiteboardPageTarget) => {
    if (inFlightRef.current) return;

    const normalizedTarget = normalizePageAddTarget(target);
    const afterPageNumber = normalizedTarget?.afterPageNumber;
    const fallbackAddPage = () => {
      if (!canManagePages) return;
      // `!== undefined`, not truthiness: 0 is "insert before page 1", and
      // treating it as absent silently appends to the end instead — the
      // opposite end of the document from the one that was asked for.
      if (afterPageNumber !== undefined) {
        insertPageAfterLocally(afterPageNumber);
      } else {
        addPageLocally();
      }
    };
    const finish = () => {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setIsAddingPage(false);
      }
    };

    inFlightRef.current = true;
    setIsAddingPage(true);

    if (onAddPage && syncReady) {
      // Enter the promise chain before invoking the adapter. Some embedders
      // perform validation synchronously; their throw must take the same
      // cleanup path as an async rejection.
      void withPageAddTimeout(Promise.resolve().then(() => onAddPage(normalizedTarget)))
        .then((response) => {
          if (!mountedRef.current) return;
          applyAddedPageResponse(response);
        })
        .catch((error) => {
          if (!mountedRef.current) return;
          console.error("Failed to add whiteboard page:", error);
          if (isRecoverablePageAddError(error) && canManagePages) {
            fallbackAddPage();
            return;
          }
          if (isAmbiguousPageAddError(error)) {
            // The add may already have landed. Say so rather than retrying
            // blind, and let the CRDT deliver the page if it did.
            emitWhiteboardError(
              "The whiteboard is slow to respond. Check whether the page appeared before adding another.",
              { title: "Page add timed out" },
            );
            return;
          }
          // Non-managers have no local fallback — without feedback the press
          // just silently does nothing.
          emitWhiteboardError("Couldn't add a page. Please try again.", {
            title: "Page not added",
          });
        })
        .finally(finish);
      return;
    }

    fallbackAddPage();
    finish();
  }, [
    addPageLocally,
    applyAddedPageResponse,
    canManagePages,
    insertPageAfterLocally,
    onAddPage,
    syncReady,
  ]);

  const addPage = useCallback(() => {
    requestAddPage();
  }, [requestAddPage]);

  const insertPageAfter = useCallback((afterPageNumber: number) => {
    requestAddPage({ afterPageNumber });
  }, [requestAddPage]);

  return {
    isAddingPage,
    addPage,
    insertPageAfter,
  };
}

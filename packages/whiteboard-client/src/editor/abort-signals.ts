/**
 * Compose abort signals on every browser this app supports.
 *
 * `AbortSignal.any` arrived in Safari 17.4 and Firefox 124, but Vite's default
 * build target admits Safari/iOS 16.4 and Firefox 114. On those, reading
 * `AbortSignal.any` yields `undefined` and calling it throws a `TypeError` —
 * which surfaces as an unrelated-looking failure at the fetch it was guarding
 * ("CORS or network error", a claim that silently never lands). Nothing in the
 * workspace polyfills it, so compose the signals directly when it is absent.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);

  const controller = new AbortController();
  const alreadyAborted = signals.find((signal) => signal.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
    return controller.signal;
  }

  // The first abort wins and carries its own reason through, so a caller can
  // still tell a timeout from a teardown. Listeners are dropped at that point:
  // the composite can never abort twice, and the sources may outlive it.
  const onAbort = (event: Event) => {
    for (const signal of signals) signal.removeEventListener("abort", onAbort);
    controller.abort((event.target as AbortSignal).reason);
  };
  for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });

  return controller.signal;
}

/** True for the `DOMException` an aborted fetch or signal-aware API rejects with. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

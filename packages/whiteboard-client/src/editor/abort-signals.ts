/** True for the `DOMException` an aborted fetch or signal-aware API rejects with. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * The admission id this tab uses to resume its place in a meeting.
 *
 * One key per meeting code, regardless of how the participant was admitted.
 * Keying by guest-vs-authenticated instead looks safer but is not: the writer
 * knows how the *server* admitted them (the issued identity), while every reader
 * only knows what the *client* believes about its session. Those disagree
 * whenever a cached session outlives its cookie, and the id is then written to a
 * key nothing reads — silently disabling reconnect and leaking the entry.
 *
 * A single key is safe because ownership is proven server-side on every use:
 * the meeting's coordinator rejects an id whose subject does not match the caller,
 * and the join hook responds by discarding it and retrying as a first-time
 * joiner. A mismatched id costs one extra round trip; a missing one costs the
 * participant their admission.
 *
 * Session storage (not local storage) is deliberate: the id is tab-scoped, so
 * two tabs on the same meeting hold independent admissions.
 */
const RECONNECT_STORAGE_PREFIX = "orbmeet.admission.";

function getReconnectStorageKey(code: string): string {
  return `${RECONNECT_STORAGE_PREFIX}${code}`;
}

export function loadReconnectAdmissionId(code: string): string | undefined {
  try {
    return sessionStorage.getItem(getReconnectStorageKey(code)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function persistReconnectAdmissionId(code: string, admissionId: string): void {
  try {
    sessionStorage.setItem(getReconnectStorageKey(code), admissionId);
  } catch {
    // storage may be unavailable
  }
}

export function clearReconnectAdmissionId(code: string): void {
  try {
    sessionStorage.removeItem(getReconnectStorageKey(code));
  } catch {
    // storage may be unavailable
  }
}

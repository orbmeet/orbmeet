const DISPLAY_NAME_STORAGE_KEY = "orbmeet.user.name";

/**
 * The remembered guest name is a convenience, never a prerequisite for joining.
 * Browsers can expose `localStorage` while still throwing on access (privacy
 * mode, embedded contexts, disabled site storage), so all access is isolated
 * behind this non-throwing boundary.
 */
export function loadStoredMeetingDisplayName(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(DISPLAY_NAME_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveStoredMeetingDisplayName(displayName: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, displayName);
  } catch {
    // Remembering a name must never block the meeting join itself.
  }
}

import { canCaptureDisplay, canCaptureDisplayAudio, getPlatformEnvironment } from "@/lib/browser-capabilities";

const SHARE_SOUND_STORAGE_KEY = "orbmeet.meeting.shareScreenSound";

/**
 * Whether this browser can send the sound of a shared screen at all: Chrome
 * and Edge on a computer. Everywhere else the picker has no sound to offer.
 */
export function canShareScreenSound(): boolean {
  return canCaptureDisplayAudio(getPlatformEnvironment());
}

/**
 * Whether this device can present its screen at all. iPhone and iPad cannot,
 * so the stage switch leaves Screen off there rather than offering a button
 * whose only answer, two taps later, is a toast saying no.
 */
export function canPresentScreen(): boolean {
  return canCaptureDisplay(getPlatformEnvironment());
}

/**
 * Whether to ask for the screen's sound with it, remembered per device. On
 * unless someone turned it off: a video shared without its soundtrack is the
 * surprise, not the other way round. Storage can throw on access, so it is
 * read and written behind a non-throwing boundary.
 */
export function loadShareScreenSound(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SHARE_SOUND_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveShareScreenSound(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SHARE_SOUND_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // A preference must never get in the way of presenting.
  }
}

/**
 * The command palette's keystroke, on its own so the room can listen for it
 * without loading the palette (and its icon set) until it is first opened.
 */

function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function commandPaletteShortcutLabel(): string {
  return isApplePlatform() ? "⌘K" : "Ctrl K";
}

/** True for the keystroke that opens the palette: ⌘K on a Mac, Ctrl+K elsewhere. */
export function isCommandPaletteShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
  if (event.key.toLowerCase() !== "k" || event.altKey || event.shiftKey) return false;
  return event.metaKey || event.ctrlKey;
}

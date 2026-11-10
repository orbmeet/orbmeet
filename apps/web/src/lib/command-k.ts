/**
 * ⌘K on Apple platforms, Ctrl+K elsewhere: "find or join" across the app, and
 * the command palette inside a meeting. On its own so a page can listen for it
 * without loading what it opens.
 */

import { isShortcut, shortcutLabel } from "@orbmeet/ui/keyboard";
import { getPlatformEnvironment, isApplePlatform } from "@/lib/browser-capabilities";

/** How this device writes the keystroke. The server cannot know, so it renders the Apple form. */
export function commandKLabel(): string {
  return shortcutLabel("k", isApplePlatform(getPlatformEnvironment()));
}

export function isCommandK(event: KeyboardEvent): boolean {
  return isShortcut(event, "k", isApplePlatform(getPlatformEnvironment()));
}

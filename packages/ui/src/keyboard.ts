/**
 * Reading keyboard events the same way everywhere.
 *
 * Four things go wrong when a handler compares `event.key` by hand, and each
 * bites a different group of people:
 *
 * - Input methods. Chinese, Japanese and Korean are typed through an IME,
 *   where Enter, Escape, Tab and the arrows pick and confirm candidates. Those
 *   presses are the IME's, not the page's. `isComposing` says so, except in
 *   Safari, which ends the composition before dispatching the Enter that ends
 *   it; that keydown still carries the IME's key code, 229.
 * - Keyboard layouts. On a Russian, Greek, Hebrew or Arabic layout the K key
 *   types "л", "κ", "ל" or "ن", so `event.key` never equals "k". Matching the
 *   physical key instead would break the reverse case: on Dvorak or AZERTY
 *   the key labelled K sits elsewhere. So a Latin letter is trusted as typed,
 *   and only a non-Latin one falls back to the key's position.
 * - The platform's modifier. ⌘ is the shortcut key on Apple devices. Ctrl is
 *   not, and Ctrl+K in any macOS text field deletes to the end of the line.
 * - Autofill. Chrome dispatches key events without a `key` when a suggestion
 *   is chosen.
 */

type KeyEvent = Pick<KeyboardEvent, "key" | "code" | "isComposing" | "keyCode">;
type ShortcutEvent = KeyEvent & Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** `KeyboardEvent.keyCode` for every key an input method consumes. */
const IME_KEY_CODE = 229;

/** True while the press belongs to an input method, not to the page. */
export function isComposing(event: KeyEvent): boolean {
  return event.isComposing || event.keyCode === IME_KEY_CODE;
}

/**
 * The page's own press of `key` ("Enter", "Escape", "Tab", "ArrowUp"…): never
 * one an input method is using to pick or confirm.
 */
export function isKey(event: KeyEvent, key: string): boolean {
  return event.key === key && !isComposing(event);
}

/** Whether the press is the letter `letter` (a-z), on any keyboard layout. */
export function isLetter(event: KeyEvent, letter: string): boolean {
  if (typeof event.key !== "string" || isComposing(event)) return false;
  const typed = event.key.toLowerCase();
  if (/^[a-z]$/.test(typed)) return typed === letter;
  return event.code === `Key${letter.toUpperCase()}`;
}

/** The platform's shortcut modifier plus `letter`, and no other modifier. */
export function isShortcut(event: ShortcutEvent, letter: string, applePlatform: boolean): boolean {
  if (event.altKey || event.shiftKey) return false;
  const modifier = applePlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return modifier && isLetter(event, letter);
}

/** How the platform writes that shortcut: "⌘K" or "Ctrl K". */
export function shortcutLabel(letter: string, applePlatform: boolean): string {
  return applePlatform ? `⌘${letter.toUpperCase()}` : `Ctrl ${letter.toUpperCase()}`;
}

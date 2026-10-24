/**
 * Whether the Board button is unavailable. Anyone may press it: a moderator
 * opens a closed board, anyone else asks a moderator to. Only a board this
 * meeting cannot open at all disables it.
 */
export function isWhiteboardToggleDisabled({ canAttemptOpen }: { canAttemptOpen: boolean }): boolean {
  return !canAttemptOpen;
}

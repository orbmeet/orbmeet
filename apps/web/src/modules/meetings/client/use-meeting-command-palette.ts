import * as React from "react";
import { isCommandPaletteShortcut } from "./meeting-command-shortcut";

export interface MeetingCommandPalette {
  /** Whether the palette is open. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /**
   * Whether it has been opened at all. It is mounted on first use and kept, so
   * it can animate closed and so ⌘K does not pay for the chunk until pressed.
   */
  mounted: boolean;
  openPalette: () => void;
}

/** The meeting's command palette, and the ⌘K / Ctrl+K shortcut that toggles it when `enabled`. */
export function useMeetingCommandPalette(enabled: boolean): MeetingCommandPalette {
  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const openPalette = React.useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);
  React.useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isCommandPaletteShortcut(event)) return;
      // Capture phase, and stopped here: the board binds ⌘K too (a link on a
      // selected shape), and inside a meeting the palette is the one that has
      // to win — it is how the board's own commands are reached.
      event.preventDefault();
      event.stopPropagation();
      setMounted(true);
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [enabled]);
  return { open, setOpen, mounted, openPalette };
}

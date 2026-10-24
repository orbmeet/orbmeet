import type { Editor } from "tldraw";

// tldraw's draw/highlight tools dispatch PointerEvent.getCoalescedEvents() for
// higher-fidelity ink. On WebKit/Apple Pencil this batch sometimes contains a
// single stale/garbage point far from the real stroke, which fuses to the
// shape as a long straight tail ("a line out of nowhere"). tldraw disables
// coalesced events on iOS for this reason, but its own UA check misses the
// desktop-mode iPad, so the artifact ships there anyway.
const COALESCED_INK_TOOL_IDS = ["draw", "highlight"] as const;

export function configureCoalescedPointerEvents(
  editor: Editor,
  disableCoalescedPointerEvents: boolean,
): void {
  if (!disableCoalescedPointerEvents) return;
  for (const id of COALESCED_INK_TOOL_IDS) {
    const tool = editor.getStateDescendant(id);
    if (tool) tool.useCoalescedEvents = false;
  }
}

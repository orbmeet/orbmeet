import { Errors } from "@/lib/app-errors";
import {
  WHITEBOARD_PIN_GIVE_UP_MS,
  isOpen,
  type MeetingState,
  type SurfaceFocus,
} from "../model";
import { bumpRoom, touch } from "./access";

export function setSurface(state: MeetingState, open: boolean, fallback: SurfaceFocus | null, now: number): void {
  if (!isOpen(state)) throw Errors.MEETING_ENDED();
  const { surface } = state;
  if (!open) {
    if (surface.open) closeSurface(state, now);
    return;
  }
  if (surface.open) return;
  const focus = surface.focus ?? fallback;
  if (!focus) throw Errors.VALIDATION("There is no whiteboard to show yet.");
  surface.focus = focus;
  surface.open = true;
  surface.revision += 1;
  surface.openRevision = surface.revision;
  answerAsks(state, "boardRequested", now);
  bumpRoom(state);
}

export function present(state: MeetingState, focus: SurfaceFocus, now: number): void {
  if (!isOpen(state)) throw Errors.MEETING_ENDED();
  const { surface } = state;
  if (surface.open && surface.focus?.usageId === focus.usageId) return;
  // Leaving a shared board is its boundary. A closed one was pinned when it closed.
  if (surface.open && surface.focus) owePin(state, surface.focus, now);
  const wasOpen = surface.open;
  surface.focus = focus;
  surface.open = true;
  surface.revision += 1;
  // Switching boards while open is not a new opening: whoever hid the surface
  // for themselves stays hidden.
  if (!wasOpen) surface.openRevision = surface.revision;
  answerAsks(state, "boardRequested", now);
  bumpRoom(state);
}

/**
 * What an ask wanted happened — the board opened, transcription turned off —
 * so every ask for it has its answer.
 */
export function answerAsks(
  state: MeetingState,
  ask: "boardRequested" | "transcriptionStopRequested",
  now: number,
): void {
  for (const admission of Object.values(state.admissions)) {
    if (!admission[ask]) continue;
    admission[ask] = false;
    touch(admission, now);
  }
}

export function closeSurface(state: MeetingState, now: number): void {
  const { surface } = state;
  if (surface.focus) owePin(state, surface.focus, now);
  surface.open = false;
  surface.revision += 1;
  bumpRoom(state);
}

function owePin(state: MeetingState, focus: SurfaceFocus, now: number): void {
  const { surface } = state;
  surface.pins[focus.usageId] = {
    ...focus,
    // Unique per boundary; the sync server and the capture key both accept it.
    commandId: `wbpin-${surface.revision + 1}-${focus.usageId}`,
    owedAt: now,
  };
}

/**
 * A pin the sync server could not take for a day is given up: the capture
 * then keeps the board's previous pin, or records that nothing was shared.
 */
export function giveUpStalePins(state: MeetingState, now: number): void {
  for (const [usageId, pin] of Object.entries(state.surface.pins)) {
    if (now - pin.owedAt >= WHITEBOARD_PIN_GIVE_UP_MS) delete state.surface.pins[usageId];
  }
}

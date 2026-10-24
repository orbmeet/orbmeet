/**
 * The phone dock's "More" menu, as data.
 *
 * The old menu was a `grid-cols-4` of whatever happened to be enabled, in DOM
 * order. On a 402pt screen that gave ~75pt per cell, so "Open for everyone"
 * rendered as "Open for ev…" and "Spoken language" as "Spoken lan…", and the
 * final row was however many items were left over. There was no grouping and no
 * ordering — which is why it read as arbitrary.
 *
 * Two changes fix that, and both live here rather than in the view:
 *
 *   1. Actions are grouped by intent and ordered within each group by how often
 *      a participant reaches for them, so position carries meaning.
 *   2. Actions carry a `detail` line for their current state, so the view can
 *      render full labels in a list instead of truncating them into a grid.
 *
 * Keeping this a pure function means the menu's shape is unit-testable without
 * mounting a room: the tests below pin the grouping, the ordering, and the
 * rules about what disappears when a capability is absent.
 */

export type DockActionId =
  | "hand"
  | "surface-existing"
  | "share"
  | "audio"
  | "background"
  | "captions"
  | "caption-language"
  | "record"
  | "stream"
  | "timer";

type DockGroupId = "collaborate" | "audio-video" | "host";

export interface DockAction {
  id: DockActionId;
  label: string;
  /** Current state, rendered as a secondary line (e.g. "Blur", "Recording"). */
  detail?: string;
  active?: boolean;
  disabled?: boolean;
  /** Why the action is unavailable; surfaced to the user, not just as a title. */
  /** Destructive/live emphasis — stop recording, stop streaming. */
  danger?: boolean;
  badge?: number;
  /** True when selecting opens a nested panel rather than acting immediately. */
  opensPanel?: boolean;
}

export interface DockGroup {
  id: DockGroupId;
  title: string;
  actions: DockAction[];
}

/**
 * What the hand button acts on. A moderator's opens the timeline, where raised
 * hands wait at the top (`queue`); anyone else's raises or lowers their own
 * hand (`queue: null`).
 */
export interface HandRaiseState {
  isHandRaised: boolean;
  queue: { open: boolean; pendingCount: number } | null;
}

export interface HandRaiseControl {
  label: string;
  active: boolean;
}

/** Your own hand: raise it, or lower it. */
export function handRaiseControl({ isHandRaised }: Pick<HandRaiseState, "isHandRaised">): HandRaiseControl {
  return { label: isHandRaised ? "Lower hand" : "Raise hand", active: isHandRaised };
}

/**
 * The sheet holds what a phone reaches for occasionally. What it reaches for
 * every minute has a place of its own: the Timeline and Talk/Board are on the
 * dock, and People and the lock are in the header, so none of them
 * is a row here as well.
 */
export interface DockActionsInput {
  isHost: boolean;

  // Collaborate
  /** Absent when the dock has no hand button. */
  handRaise: HandRaiseState | null;
  surfaceActive?: boolean;
  canChooseExistingSurface: boolean;
  chooseExistingSurfaceLabel?: string;
  isScreenSharing: boolean;

  // Audio & video
  canConfigureAudio: boolean;
  audioDeviceLabel?: string;
  backgroundSupported: boolean;
  backgroundLabel?: string;
  backgroundProcessing?: boolean;
  /** Absent where the dock cannot turn captions on and off. */
  captionsShown?: boolean;
  captionLanguageLabel?: string;

  // Host
  canRecord: boolean;
  isRecording: boolean;
  recordingDisabled: boolean;
  recordingDisabledReason?: string | null;
  canStream: boolean;
  isStreaming: boolean;
  streamingDisabled: boolean;
  /** The shared timer is everyone's to see; only hosts and moderators change it. */
  countdownActive: boolean;
  countdownLabel?: string;
}

function compact(actions: (DockAction | null)[]): DockAction[] {
  return actions.filter((action): action is DockAction => action !== null);
}

export function selectDockGroups(input: DockActionsInput): DockGroup[] {
  const collaborate = compact([
    // A moderator's raised hands are answered in the timeline, which carries
    // their count; only someone who can raise a hand gets a hand button.
    input.handRaise && !input.handRaise.queue ? { id: "hand", ...handRaiseControl(input.handRaise) } : null,
    // Only offered while the surface is closed — once it is open, "choose a
    // different one" is a job for the surface's own chrome, not this menu.
    input.canChooseExistingSurface && !input.surfaceActive
      ? {
          id: "surface-existing",
          label: input.chooseExistingSurfaceLabel ?? "Choose existing",
          opensPanel: true,
        }
      : null,
    {
      id: "share",
      label: input.isScreenSharing ? "Stop sharing" : "Share screen",
      active: input.isScreenSharing,
    },
    // Everyone's, like on desktop: the panel is read-only for anyone who
    // cannot control the timer.
    {
      id: "timer",
      label: "Timer",
      detail: input.countdownActive ? input.countdownLabel : undefined,
      active: input.countdownActive,
      opensPanel: true,
    },
  ]);

  const audioVideo = compact([
    input.canConfigureAudio
      ? {
          id: "audio",
          label: "Audio devices",
          detail: input.audioDeviceLabel ?? "System default",
          opensPanel: true,
        }
      : null,
    input.backgroundSupported
      ? {
          id: "background",
          label: "Background",
          detail: input.backgroundProcessing
            ? "Applying…"
            : (input.backgroundLabel ?? "None"),
          active: Boolean(input.backgroundLabel),
          opensPanel: true,
        }
      : null,
    input.captionsShown === undefined
      ? null
      : {
          id: "captions",
          label: input.captionsShown ? "Hide captions" : "Show captions",
          active: input.captionsShown,
        },
    {
      id: "caption-language",
      label: "My spoken language",
      detail: input.captionLanguageLabel,
      opensPanel: true,
    },
  ]);

  const host = input.isHost
    ? compact([
        input.canRecord
          ? {
              id: "record",
              label: input.isRecording ? "Stop recording" : "Record meeting",
              detail: input.isRecording
                ? "Recording"
                : input.recordingDisabled
                  ? (input.recordingDisabledReason ?? "Unavailable")
                  : undefined,
              active: input.isRecording,
              danger: input.isRecording,
              disabled: input.recordingDisabled,
            }
          : null,
        input.canStream
          ? {
              id: "stream",
              label: input.isStreaming ? "Stop stream" : "Go live",
              detail: input.isStreaming ? "Streaming" : undefined,
              active: input.isStreaming,
              danger: input.isStreaming,
              disabled: input.streamingDisabled,
              opensPanel: !input.isStreaming,
            }
          : null,
      ])
    : [];

  return [
    { id: "collaborate" as const, title: "In this meeting", actions: collaborate },
    { id: "audio-video" as const, title: "Audio & video", actions: audioVideo },
    { id: "host" as const, title: "Host controls", actions: host },
  ].filter((group) => group.actions.length > 0);
}

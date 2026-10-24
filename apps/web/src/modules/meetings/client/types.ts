import type { MeetingRole } from "../contract/constants";
import type { BackgroundMode } from "./use-background-effect";

/** What the pre-join screen submits when the user clicks Join. */
export interface PreJoinSubmission {
  videoDeviceId?: string;
  audioDeviceId?: string;
  audioOutputDeviceId?: string;
  videoEnabled: boolean;
  audioEnabled: boolean;
  displayName?: string;
  captionLanguage?: string;
  bgMode: BackgroundMode;
  bgImagePath: string | null;
}

export interface MeetingLifecycleHooks {
  onBeforeLeave?: () => Promise<void>;
  onBeforeEnd?: () => Promise<void>;
}

/**
 * Permission requests surfaced to hosts. The meeting owns screen-share and
 * admission requests; extension surfaces contribute their own via
 * MeetingExtensions.extraPermissions, carrying their own copy so the meeting
 * UI never hard-codes extension vocabulary.
 */
export type HostPermissionRequest =
  | {
      kind: "screen-share";
      id: string;
      userId: string;
      userName: string;
      decisionPending?: boolean;
    }
  | {
      kind: "extension";
      id: string;
      userId: string;
      userName: string;
      /** Short noun phrase for accessibility labels, e.g. "whiteboard access". */
      actionLabel: string;
      /** One-line request description shown to the host. */
      description: string;
      /**
       * True when the requester joined as a guest rather than a signed-in
       * user. The host tray prints it beside the name — as context, never
       * instead of one.
       */
      guest?: boolean;
      decisionPending?: boolean;
    }
  | {
      kind: "meeting-admission";
      id: string;
      admissionId: string;
      userId: string | null;
      userName: string;
      role: MeetingRole;
      decisionPending?: boolean;
    };


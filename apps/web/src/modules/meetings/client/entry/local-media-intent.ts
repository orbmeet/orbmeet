import type { BackgroundMode } from "@/modules/meetings/client/use-background-effect";
import type { PreJoinSubmission } from "@/modules/meetings/client/types";

/**
 * What this participant has chosen for their own media and captions.
 *
 * A LiveKit `Room` lives for one connection; a meeting can go through several
 * (an automatic rejoin, the recheck after a removal, a peer-connection
 * fallback). Choices made inside the meeting — muting, turning the camera off,
 * switching a device, picking a background or a caption language — are
 * written here, and every new connection starts from what is here. Nothing
 * reads the pre-join screen's submission directly once the meeting is joined.
 */
export interface LocalMediaIntent {
  audioEnabled: boolean;
  videoEnabled: boolean;
  audioDeviceId?: string;
  videoDeviceId?: string;
  audioOutputDeviceId?: string;
  captionLanguage: string;
  bgMode: BackgroundMode;
  bgImagePath: string | null;
}

export const DEFAULT_CAPTION_LANGUAGE = "en-US";

export function intentFromPreJoin(submission: PreJoinSubmission): LocalMediaIntent {
  return {
    audioEnabled: submission.audioEnabled,
    videoEnabled: submission.videoEnabled,
    audioDeviceId: submission.audioDeviceId,
    videoDeviceId: submission.videoDeviceId,
    audioOutputDeviceId: submission.audioOutputDeviceId,
    captionLanguage: submission.captionLanguage ?? DEFAULT_CAPTION_LANGUAGE,
    bgMode: submission.bgMode,
    bgImagePath: submission.bgImagePath,
  };
}

/** Holds the intent and notifies subscribers; each value is an immutable snapshot. */
export class LocalMediaIntentStore {
  private value: LocalMediaIntent | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = (): LocalMediaIntent | null => this.value;

  replace(next: LocalMediaIntent): void {
    this.value = next;
    this.notify();
  }

  /** Merge a change made in the meeting. Ignored before the first submission. */
  update(patch: Partial<LocalMediaIntent>): void {
    const current = this.value;
    if (!current) return;
    const keys = Object.keys(patch) as Array<keyof LocalMediaIntent>;
    if (keys.every((key) => current[key] === patch[key])) return;
    this.value = { ...current, ...patch };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

import type { BackgroundMode } from "@/modules/meetings/client/use-background-effect";
import type { HandRaiseState } from "@/modules/meetings/client/dock-actions";

// Control groups shared by the desktop control dock and the phone dock. Each
// dock renders the subset its layout has room for, but both receive the same
// shapes from the live Meeting layout.

export interface DockAudioDeviceControls {
  audioDevices: MediaDeviceInfo[];
  currentAudioDeviceId: string | undefined;
  handleSelectAudioDevice: (deviceId: string | undefined) => Promise<void>;
  audioOutputDevices: MediaDeviceInfo[];
  currentAudioOutputDeviceId: string | undefined;
  handleSelectAudioOutputDevice: (deviceId: string | undefined) => Promise<void>;
}

export interface DockBackgroundControls {
  mode: BackgroundMode;
  imagePath: string | null;
  isSupported: boolean;
  isProcessing: boolean;
  clearEffect: () => void;
  setBlur: () => void;
  setImage: (path: string) => void;
}

export interface DockHandRaiseControls extends HandRaiseState {
  onToggle: () => void;
}

export interface DockSecurityControls {
  secured: boolean;
  pending: boolean;
  /** Omit when the actor cannot change the join policy. */
  onToggle?: () => void;
}

/**
 * A shared screen on the room's stage: whose it is, whether this participant
 * is looking at it, and the ways to look at it and to set it aside for Talk
 * or the board while it carries on.
 */
export interface SharedScreenControls {
  /** The sharer's name; null while it is this participant's own screen. */
  presenterName: string | null;
  shown: boolean;
  onShow: () => void;
  onSetAside: () => void;
}

/**
 * What a phone's stage shows, and the ways to switch it: Talk, the board while
 * there is one, and a shared screen while someone shares one.
 */
export interface PhoneStageModes {
  shown: "talk" | "board" | "screen";
  onTalk: () => void;
  onBoard?: () => void;
  /** The board's name, as the surface gives it. */
  boardLabel?: string;
  onScreen?: () => void;
}

/** The toolbar controls an extension surface (e.g. the Whiteboard) exposes. */
export interface SurfaceToolbarControls {
  /** User-facing name of the surface (e.g. "Board"); the Meeting UI
   * derives all surface control copy from it. */
  label: string;
  /** Scope-aware action copy, e.g. "Hide for me" or "Close for everyone". */
  toggleLabel?: string;
  /**
   * Name of the open document, when the surface has one. Shown where a full
   * title fits — tooltips, the identity line — never in the dock's label
   * slot, which is too narrow to end in anything but an ellipsis.
   */
  documentTitle?: string | null;
  /** This participant is looking at the surface (Board view) rather than faces (Talk view). */
  active?: boolean;
  /**
   * This participant asked a host to open the surface and is waiting for the
   * answer. Showing the board again takes the ask back.
   */
  asked?: boolean;
  /** Flips this participant between the Board and Talk views. */
  onToggle?: () => void;
  /** The Board view, opening the surface for everyone when a moderator asks for a closed one. */
  onShowBoard?: () => void;
  /** The Talk view. The board stays open for everyone else. */
  onShowTalk?: () => void;
  /** Moderators only: close the surface for the whole room. */
  onCloseForEveryone?: () => void;
  /** Optional secondary path for choosing an existing surface document. */
  onChooseExisting?: () => void;
  chooseExistingLabel?: string;
  /** The presenter's: make the page they are on the room's. */
  onSync?: () => void;
  /**
   * Following whoever is presenting the board. Present only while someone
   * other than you is presenting; omit otherwise.
   */
  follow?: SurfaceFollowControls;
  disabled?: boolean;
  disabledReason?: string | null;
}

/**
 * Whether your view of the board tracks the presenter's.
 *
 * Everyone follows the presenter by default — that is what a class or a
 * review needs. Stopping lets you look back at an earlier page without being
 * pulled away every time the presenter moves; following again jumps you to
 * where they are now.
 */
interface SurfaceFollowControls {
  presenterName: string;
  following: boolean;
  onFollow: () => void;
  onStopFollowing: () => void;
}

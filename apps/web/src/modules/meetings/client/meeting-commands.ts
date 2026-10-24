/**
 * The room's command palette, as data.
 *
 * Every control in the top bar is also a command here, so the room can be run
 * from the keyboard without hunting for a 40px glyph — and the handful of
 * actions that live three taps deep (lock the meeting, bring everyone to your
 * page, close the board for everyone) are one search away.
 *
 * Commands are built from the same props the bar's controls receive, so a
 * command can never offer something its control would refuse: a participant
 * who cannot record gets no "Record" command rather than one that fails.
 * Pure, so the list and the matching are tested without mounting a room.
 */
import type { ElementType } from "react";
import {
  Captions,
  CircleDot,
  Eye,
  EyeOff,
  Hand,
  Layers,
  LayoutGrid,
  Link2,
  LocateFixed,
  LogOut,
  MessageSquareLock,
  MessageSquareText,
  Mic,
  MicOff,
  Monitor,
  PhoneOff,
  Shield,
  ShieldCheck,
  Square,
  SquarePen,
  Users,
  Video,
  VideoOff,
  XCircle,
} from "lucide-react";
import type { SurfaceToolbarControls } from "@/modules/meetings/client/components/dock-controls";

export type MeetingCommandGroup = "You" | "People" | "Stage" | "Board" | "Room" | "Leave";

/** Display order of the groups; matching never reorders them. */
export const MEETING_COMMAND_GROUPS: readonly MeetingCommandGroup[] = ["You", "People", "Stage", "Board", "Room", "Leave"];

export interface MeetingCommand {
  id: string;
  group: MeetingCommandGroup;
  label: string;
  /** Other words someone might type for it ("mute" for the microphone). */
  keywords?: readonly string[];
  /** A second line: why it is disabled, or what it will do. */
  hint?: string;
  /** The key that does the same thing outside the palette, for display. */
  shortcut?: string;
  icon: ElementType;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

export interface MeetingCommandInput {
  mic: { on: boolean; toggle: () => void };
  camera: { on: boolean; toggle: () => void };
  /** Raising your own hand. Omitted for moderators. */
  hand?: { raised: boolean; toggle: () => void };
  screenShare: { sharing: boolean; toggle: () => void };
  surface?: SurfaceToolbarControls;
  /** Whether what is said shows in the Timeline, for this viewer. */
  speech: { shown: boolean; toggle: () => void };
  /** Whether the latest line of what is said is laid over the meeting, for this viewer. */
  captions: { shown: boolean; toggle: () => void };
  timeline: { open: boolean; toggle: () => void };
  /** Omit where the people are already on screen and there is no People panel. */
  people?: { open: boolean; toggle: () => void };
  /** Omit for anyone who cannot record. */
  recording?: { recording: boolean; disabledReason: string | null; toggle: () => void };
  /** Omit for anyone who cannot change the join policy. */
  security?: { secured: boolean; pending: boolean; toggle: () => void };
  /** Raised hands, longest-waiting first, for whoever can give the floor. */
  hands?: { queue: readonly { userId: string; userName: string }[]; callOn: (userId: string) => void };
  /** Everyone else here, to write to privately. */
  messagePrivately?: { people: readonly { id: string; name: string }[]; open: (person: { id: string; name: string }) => void };
  copyLink: () => void;
  leave: () => void;
  /** Omit for anyone who cannot end the meeting. */
  endForEveryone?: () => void;
}

export function buildMeetingCommands(input: MeetingCommandInput): MeetingCommand[] {
  const commands: MeetingCommand[] = [];
  const { surface } = input;

  commands.push({
    id: "mic",
    group: "You",
    label: input.mic.on ? "Mute microphone" : "Unmute microphone",
    keywords: ["mic", "audio", "mute", "unmute", "sound"],
    icon: input.mic.on ? MicOff : Mic,
    run: input.mic.toggle,
  });
  commands.push({
    id: "camera",
    group: "You",
    label: input.camera.on ? "Turn camera off" : "Turn camera on",
    keywords: ["camera", "video", "webcam"],
    icon: input.camera.on ? VideoOff : Video,
    run: input.camera.toggle,
  });
  if (input.hand) {
    commands.push({
      id: "hand",
      group: "You",
      label: input.hand.raised ? "Lower hand" : "Raise hand",
      keywords: ["hand", "question", "speak"],
      shortcut: "H",
      icon: Hand,
      run: input.hand.toggle,
    });
  }

  input.hands?.queue.forEach((hand, index) => {
    commands.push({
      id: `call-on:${hand.userId}`,
      group: "People",
      label: `Call on ${hand.userName}`,
      hint: index === 0 ? "First in line" : `${ordinal(index + 1)} in line`,
      keywords: ["hand", "call", "speak", "floor", "question"],
      icon: Hand,
      run: () => input.hands?.callOn(hand.userId),
    });
  });
  for (const person of input.messagePrivately?.people ?? []) {
    commands.push({
      id: `message:${person.id}`,
      group: "People",
      label: `Message ${person.name} privately`,
      hint: "Only the two of you see it",
      keywords: ["private", "message", "dm", "chat", "direct"],
      icon: MessageSquareLock,
      run: () => input.messagePrivately?.open(person),
    });
  }

  if (surface) {
    const boardShown = surface.active === true;
    const showBoard = surface.onShowBoard ?? surface.onToggle;
    const showTalk = surface.onShowTalk ?? surface.onToggle;
    if (boardShown && showTalk) {
      commands.push({
        id: "view-talk",
        group: "Stage",
        label: "Switch to Talk",
        hint: "Faces, with the board one tap away",
        keywords: ["faces", "video", "gallery", "people"],
        icon: Users,
        run: showTalk,
      });
    }
    if (!boardShown && showBoard) {
      commands.push({
        id: "view-board",
        group: "Stage",
        label: "Switch to Board",
        hint: surface.disabled ? (surface.disabledReason ?? undefined) : surface.toggleLabel,
        keywords: ["whiteboard", "draw", "canvas", surface.label.toLowerCase()],
        icon: SquarePen,
        disabled: surface.disabled === true,
        run: showBoard,
      });
    }
  }
  commands.push({
    id: "share",
    group: "Stage",
    label: input.screenShare.sharing ? "Stop sharing your screen" : "Share your screen",
    keywords: ["present", "screen", "share"],
    icon: Monitor,
    run: input.screenShare.toggle,
  });

  if (surface?.active) {
    const follow = surface.follow;
    if (follow) {
      commands.push(
        follow.following
          ? {
              id: "board-unfollow",
              group: "Board",
              label: `Stop following ${follow.presenterName}`,
              hint: "Look around the board on your own",
              keywords: ["follow", "presenter", "detach"],
              icon: EyeOff,
              run: follow.onStopFollowing,
            }
          : {
              id: "board-follow",
              group: "Board",
              label: `Follow ${follow.presenterName}`,
              hint: "Jump to their page and stay with them",
              keywords: ["follow", "presenter", "spotlight"],
              icon: Eye,
              run: follow.onFollow,
            },
      );
    }
    if (surface.onSync) {
      commands.push({
        id: "board-sync",
        group: "Board",
        label: "Bring everyone to my page",
        keywords: ["sync", "spotlight", "present", "follow me"],
        icon: LocateFixed,
        run: surface.onSync,
      });
    }
  }
  if (surface?.onChooseExisting) {
    commands.push({
      id: "board-open",
      group: "Board",
      label: surface.chooseExistingLabel ?? "Open another board",
      hint: "Present a board from this Space or your library",
      keywords: ["whiteboard", "library", "choose"],
      icon: Layers,
      disabled: surface.disabled === true,
      run: surface.onChooseExisting,
    });
  }
  if (surface?.onCloseForEveryone) {
    commands.push({
      id: "board-close",
      group: "Board",
      label: "Close the board for everyone",
      hint: "Everyone goes back to faces until it is opened again",
      keywords: ["whiteboard", "end", "hide"],
      icon: XCircle,
      danger: true,
      run: surface.onCloseForEveryone,
    });
  }

  commands.push({
    id: "timeline",
    group: "Room",
    label: input.timeline.open ? "Close the conversation" : "Open the conversation",
    keywords: ["chat", "messages", "captions", "transcript", "hands"],
    shortcut: "C",
    icon: MessageSquareText,
    run: input.timeline.toggle,
  });
  commands.push({
    id: "captions",
    group: "Room",
    label: input.captions.shown ? "Hide captions" : "Show captions",
    keywords: ["captions", "subtitles", "cc", "closed captions"],
    icon: Captions,
    run: input.captions.toggle,
  });
  commands.push({
    id: "speech",
    group: "Room",
    label: input.speech.shown ? "Hide what's said in the conversation" : "Show what's said in the conversation",
    keywords: ["transcript", "speech", "what's said"],
    icon: MessageSquareText,
    run: input.speech.toggle,
  });
  if (input.people) {
    commands.push({
      id: "people",
      group: "Room",
      label: input.people.open ? "Close the people list" : "Show everyone in the meeting",
      keywords: ["people", "participants", "attendees"],
      icon: LayoutGrid,
      run: input.people.toggle,
    });
  }
  commands.push({
    id: "copy-link",
    group: "Room",
    label: "Copy the meeting link",
    keywords: ["invite", "link", "url", "share"],
    icon: Link2,
    run: input.copyLink,
  });
  if (input.recording) {
    const { recording } = input;
    commands.push({
      id: "record",
      group: "Room",
      label: recording.recording ? "Stop recording" : "Record meeting",
      keywords: ["record", "recording", "rec"],
      icon: recording.recording ? Square : CircleDot,
      // Stopping is always allowed; only starting can be unavailable.
      disabled: !recording.recording && recording.disabledReason !== null,
      hint: recording.recording ? undefined : (recording.disabledReason ?? undefined),
      run: recording.toggle,
    });
  }
  if (input.security) {
    const { security } = input;
    commands.push({
      id: "lock",
      group: "Room",
      label: security.secured ? "Unlock meeting" : "Lock meeting",
      hint: security.secured ? "Anyone with the link will be able to join" : "Approval will be required to join",
      keywords: ["lock", "security", "admission", "approval"],
      icon: security.secured ? Shield : ShieldCheck,
      disabled: security.pending,
      run: security.toggle,
    });
  }

  commands.push({
    id: "leave",
    group: "Leave",
    label: "Leave meeting",
    hint: input.endForEveryone ? "Everyone else stays in the call" : "You can rejoin with the same link",
    keywords: ["exit", "quit", "hang up"],
    icon: LogOut,
    run: input.leave,
  });
  if (input.endForEveryone) {
    commands.push({
      id: "end",
      group: "Leave",
      label: "End meeting for everyone",
      hint: "Disconnects every participant",
      keywords: ["end", "close", "stop", "hang up"],
      icon: PhoneOff,
      danger: true,
      run: input.endForEveryone,
    });
  }

  return commands;
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

function rank(command: MeetingCommand, query: string): number {
  const label = command.label.toLowerCase();
  if (label.startsWith(query)) return 0;
  if (label.split(/\s+/).some((word) => word.startsWith(query))) return 1;
  if (label.includes(query)) return 2;
  if (command.keywords?.some((keyword) => keyword.split(/\s+/).some((word) => word.startsWith(query)))) return 3;
  return Number.POSITIVE_INFINITY;
}

/**
 * The commands that match what was typed, best first.
 *
 * Every whitespace-separated term has to match, so "stop rec" finds "Stop
 * recording" and not everything with "stop" in it. The empty query is the
 * whole list in display order — the palette doubles as a menu of everything
 * the room can do.
 */
export function matchMeetingCommands(
  commands: readonly MeetingCommand[],
  rawQuery: string,
): MeetingCommand[] {
  const terms = rawQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return MEETING_COMMAND_GROUPS.flatMap((group) => commands.filter((command) => command.group === group));
  }
  const scored = commands
    .map((command, order) => {
      const scores = terms.map((term) => rank(command, term));
      return { command, order, score: Math.max(...scores) };
    })
    .filter((entry) => Number.isFinite(entry.score));
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  return scored.map((entry) => entry.command);
}

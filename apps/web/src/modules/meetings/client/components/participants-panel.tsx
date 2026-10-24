import * as React from "react";
import { Captions, Mic, MicOff, X, DoorOpen, Lock, LockOpen, MessageSquareLock, UserMinus, UserPlus } from "lucide-react";
import { useSpeakingParticipants } from "@livekit/components-react";
import { enter, progress } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion, pressable, row, stack } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, success, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { Avatar, Button, Switch } from "@orbmeet/ui/react";

import { sidePanel } from "@/modules/meetings/client/meeting-styles";
import type { MeetingRole } from "@/modules/meetings/contract/constants";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import type { DockSecurityControls } from "./dock-controls";
import { canChangeModerator, canMessagePrivately, canRemoveParticipant, useRemovalConfirmation } from "./participant-actions";

interface Participant {
  id: string;
  name: string;
  role: MeetingRole;
  isGuest?: boolean;
  isMicOn?: boolean;
}

interface ParticipantsPanelProps {
  participants: Participant[];
  currentUserId?: string;
  onClose: () => void;
  canManageModerators?: boolean;
  moderatorUpdatePending?: ReadonlySet<string>;
  onSetModerator?: (participantIdentity: string, moderator: boolean) => void;
  /** The viewer moderates: they may remove attendees, and a host moderators too. */
  canRemoveParticipants?: boolean;
  removalPending?: ReadonlySet<string>;
  onRemoveParticipant?: (participantIdentity: string) => void;
  /** Opens a private thread with someone in the Timeline. */
  onMessagePrivately?: (participant: { id: string; name: string }) => void;
  /** Copies the meeting's link: who else should be here. */
  onInvite?: () => void;
  /** Who may walk in. The switch is there for whoever may change it. */
  security?: DockSecurityControls;
  /**
   * Whether what people say is sent to Deepgram. A host or co-host has the
   * switch; everyone else sees the state and can ask them to stop it.
   */
  transcription?: PanelTranscriptionControls;
  hideHeader?: boolean;
  sx?: StyleXStyles;
}

const styles = stylex.create({
  title: { margin: 0, fontSize: text.sm, fontWeight: weight.semibold, color: neutral.n800 },
  /** The count line under the title: who is here, in one glance. */
  subtitle: { margin: 0, fontSize: text.xs, color: ink.muted },

  /** A row that is not you rests on the tinted body; your own row is a card. */
  rowIdle: {
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover": neutral.n50 },
    },
  },
  rowYou: {
    backgroundColor: surface.raised,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    boxShadow: `0 1px 2px color-mix(in oklab, ${ink.strong} 5%, transparent)`,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    borderRadius: radii.control,
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
  },
  /** Name and role badges, between the portrait and the mic tile. */
  rowBody: { minWidth: 0, flexGrow: 1 },

  portrait: { position: "relative" },
  /**
   * Speaking is a live state, so the dot keeps breathing under reduced motion —
   * frozen at full opacity it is indistinguishable from "recording".
   */
  speakingDot: {
    position: "absolute",
    right: -2,
    bottom: -2,
    display: "flex",
    height: 14,
    width: 14,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    backgroundColor: accent.a500,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: surface.raised,
  },
  speakingDotCore: {
    height: 4,
    width: 4,
    borderRadius: radii.pill,
    backgroundColor: ink.onDark,
  },

  name: { fontSize: text.sm, fontWeight: weight.medium, color: neutral.n700 },
  /** Amber is the host's crown: authority, not an action. */


  youBadge: {
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: accent.a100,
    backgroundColor: accent.a50,
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    fontSize: text.xs2,
    fontWeight: weight.medium,
    color: accent.a700,
  },
  guestLine: {
    marginTop: space.s0_5,
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    fontSize: text.xs,
    color: ink.muted,
  },

  moderatorToggle: {
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": neutral.n100 } },
    paddingInline: space.s2,
    paddingBlock: space.s1,
    fontSize: text.xs2,
    fontWeight: weight.medium,
    color: neutral.n600,
    // `wait`: the update is in flight; the row is not refusing the click.
    cursor: { default: "pointer", ":disabled": "wait" },
    opacity: { default: 1, ":disabled": 0.5 },
  },

  /** Writing to someone privately: a quiet action, not a destructive one. */
  messageAction: {
    display: "flex",
    height: 24,
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.field,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n800 } },
    cursor: "pointer",
  },
  removeAction: {
    display: "flex",
    height: 24,
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.field,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": danger.d50 } },
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": danger.d600 } },
    cursor: { default: "pointer", ":disabled": "wait" },
    opacity: { default: 1, ":disabled": 0.5 },
  },

  micState: {
    display: "flex",
    height: 24,
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
  },
  micOn: {
    backgroundColor: success.s50,
    borderColor: success.s100,
    color: success.s600,
  },
  micOff: {
    backgroundColor: danger.d50,
    borderColor: danger.d100,
    color: danger.d500,
  },

  invite: { paddingInline: space.s3, paddingTop: space.s3 },
  inviteButton: { width: "100%" },
  /** The room's door, at the foot of the list of who came through it. */
  lock: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s3,
    margin: space.s3,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: surface.raised,
    padding: space.s3,
    color: neutral.n600,
  },
  lockText: { minWidth: 0, flexGrow: 1 },
  lockTitle: { margin: 0, fontSize: text.sm, fontWeight: weight.semibold, color: neutral.n800 },
  lockNote: { margin: 0, fontSize: text.xs, color: ink.muted },
});

export interface PanelTranscriptionControls {
  on: boolean;
  pending: boolean;
  /** Host or co-host: the switch is theirs. */
  canChange: boolean;
  onChange: (on: boolean) => void;
  /** Waiting on a host to answer this participant's ask. */
  asked: boolean;
  onAsk: () => void;
  onTakeBack: () => void;
}

export function ParticipantsPanel({
  participants,
  currentUserId,
  onClose,
  canManageModerators = false,
  moderatorUpdatePending,
  onSetModerator,
  canRemoveParticipants = false,
  removalPending,
  onRemoveParticipant,
  onMessagePrivately,
  onInvite,
  security,
  transcription,
  hideHeader,
  sx,
}: ParticipantsPanelProps) {
  const removal = useRemovalConfirmation(onRemoveParticipant);
  const lockLabelId = React.useId();
  const management = {
    currentUserId,
    canManageModerators,
    onSetModerator,
    canRemoveParticipants,
    onRemoveParticipant,
    onMessagePrivately,
  };
  // Read here, where it is shown: active speakers change many times a second,
  // and carrying them on the meeting's participant list would re-render the
  // whole meeting with every change.
  const speakers = useSpeakingParticipants();
  const speakingIds = React.useMemo(() => new Set(speakers.map((speaker) => speaker.identity)), [speakers]);
  const sortedParticipants = [...participants].sort((a, b) => {
    // Host first
    if (a.role === "host" && b.role !== "host") return -1;
    if (a.role !== "host" && b.role === "host") return 1;

    // Then current user
    if (a.id === currentUserId) return -1;
    if (b.id === currentUserId) return 1;

    // Then alphabetically
    return a.name.localeCompare(b.name);
  });

  const hostCount = participants.filter(p => p.role === "host").length;
  const guestCount = participants.filter(p => p.isGuest).length;

  return (
    // The shell, header and close button are `sidePanel.*`: this is one of the
    // room's four side panels and now wears the one definition they share.
    <div {...stylex.props(sidePanel.shell, enter.panel, sx)}>
      {/* Header */}
      {!hideHeader && (
        <div {...stylex.props(sidePanel.header)}>
          <div>
            <h2 {...stylex.props(styles.title)}>
              Participants
            </h2>
            <p {...stylex.props(styles.subtitle)}>
              {participants.length} {participants.length === 1 ? "person" : "people"}
              {hostCount > 0 && ` • ${hostCount} host${hostCount > 1 ? "s" : ""}`}
              {guestCount > 0 && ` • ${guestCount} guest${guestCount > 1 ? "s" : ""}`}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close participants panel"
            {...stylex.props(pressable.base, motion.tint, focus.ring, sidePanel.close)}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {onInvite && (
        <div {...stylex.props(styles.invite)}>
          <Button variant="secondary" size="sm" onClick={onInvite} sx={styles.inviteButton}>
            <UserPlus size={16} aria-hidden="true" />
            Invite · copy the link
          </Button>
        </div>
      )}

      {/* Participants List */}
      <div {...stylex.props(sidePanel.body, sidePanel.bodyTinted)}>
        <div {...stylex.props(stack.x1)}>
          {sortedParticipants.map((p) => {
            const isYou = p.id === currentUserId;
            const isHost = p.role === "host";
            const isModerator = p.role === "moderator";
            const isMicOn = p.isMicOn ?? true;
            const roleUpdatePending = moderatorUpdatePending?.has(p.id) ?? false;
            const canRemove = canRemoveParticipant(p, management);

            return (
              <div
                key={p.id}
                {...stylex.props(
                  styles.row,
                  motion.tint,
                  isYou ? styles.rowYou : styles.rowIdle,
                )}
              >
                {/* Avatar with status indicator */}
                <div {...stylex.props(styles.portrait)}>
                  <Avatar name={p.name || p.id || "User"} size="md" />

                  {/* Speaking indicator */}
                  {speakingIds.has(p.id) && (
                    <div {...stylex.props(styles.speakingDot)}>
                      <div {...stylex.props(styles.speakingDotCore, progress.pulse)} />
                    </div>
                  )}
                </div>

                {/* Name & Role */}
                <div {...stylex.props(styles.rowBody)}>
                  <div {...stylex.props(row.x2)}>
                    <span {...stylex.props(styles.name, layout.truncate)}>
                      {p.name || p.id || "Unknown"}
                    </span>

                    {/* You badge */}
                    {isYou && (
                      <span {...stylex.props(styles.youBadge)}>
                        You
                      </span>
                    )}
                  </div>

                  {/* Role, in words, under the name */}
                  {isHost ? (
                    <div {...stylex.props(styles.guestLine)}>Host</div>
                  ) : isModerator ? (
                    <div {...stylex.props(styles.guestLine)}>Moderator</div>
                  ) : p.isGuest && !isYou ? (
                    <div {...stylex.props(styles.guestLine)}>
                      <DoorOpen size={12} />
                      <span>Guest</span>
                    </div>
                  ) : null}
                </div>

                {canMessagePrivately(p, management) && (
                  <button
                    type="button"
                    onClick={() => onMessagePrivately?.({ id: p.id, name: p.name || "Participant" })}
                    title="Message privately"
                    aria-label={`Message ${p.name || "participant"} privately`}
                    {...stylex.props(pressable.base, motion.tint, focus.ring, styles.messageAction)}
                  >
                    <MessageSquareLock size={14} />
                  </button>
                )}

                {canChangeModerator(p, management) && (
                  <button
                    type="button"
                    disabled={roleUpdatePending}
                    onClick={() => onSetModerator?.(p.id, !isModerator)}
                    {...stylex.props(pressable.base, motion.tint, focus.ring, styles.moderatorToggle)}
                  >
                    {roleUpdatePending
                      ? "Updating…"
                      : isModerator
                        ? "Remove moderator"
                        : "Make moderator"}
                  </button>
                )}

                {canRemove && (
                  <button
                    type="button"
                    disabled={removalPending?.has(p.id) ?? false}
                    onClick={() => removal.requestRemoval(p)}
                    title="Remove from meeting"
                    aria-label={`Remove ${p.name || "participant"} from meeting`}
                    {...stylex.props(pressable.base, motion.tint, focus.ring, styles.removeAction)}
                  >
                    <UserMinus size={14} />
                  </button>
                )}

                {/* Mic status */}
                <div
                  role="img"
                  aria-label={isMicOn ? "Microphone on" : "Microphone off"}
                  {...stylex.props(styles.micState, isMicOn ? styles.micOn : styles.micOff)}
                >
                  {isMicOn ? (
                    <Mic size={12} />
                  ) : (
                    <MicOff size={12} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* No footer note about moderation.
       *
       * This told every non-host "A moderator can mute you at any time" and
       * "If muted by a host, you can't unmute yourself". Neither is true:
       * nothing in the product can mute another participant — the only actions
       * on a participant are the moderator toggle and removal above, and a repository-wide
       * search for a force-mute path (mutePublishedTrack, mutedByHost) finds
       * none. It was describing a security model the room does not have, to
       * exactly the people who would rely on it.
       *
       * If host moderation ships, this is the copy to restore — and only then.
       */}

      {transcription && <TranscriptionCard transcription={transcription} />}

      {security?.onToggle && (
        <div {...stylex.props(styles.lock)}>
          {security.secured ? <Lock size={18} aria-hidden="true" /> : <LockOpen size={18} aria-hidden="true" />}
          <div {...stylex.props(styles.lockText)}>
            <p id={lockLabelId} {...stylex.props(styles.lockTitle)}>Lock the meeting</p>
            <p {...stylex.props(styles.lockNote)}>
              {security.secured ? "New people wait for you to let them in." : "Open: anyone with the link can join."}
            </p>
          </div>
          <Switch
            checked={security.secured}
            pending={security.pending}
            onCheckedChange={security.onToggle}
            aria-labelledby={lockLabelId}
          />
        </div>
      )}

      {removal.dialog}
    </div>
  );
}

function TranscriptionCard({ transcription }: { transcription: PanelTranscriptionControls }) {
  const labelId = React.useId();
  const { on } = transcription;
  const note = on
    ? "What people say is sent to Deepgram for captions, the transcript and the summary."
    : "Nothing anyone says is sent to Deepgram: no captions, transcript or summary.";

  return (
    <div {...stylex.props(styles.lock)}>
      <Captions size={18} aria-hidden="true" />
      <div {...stylex.props(styles.lockText)}>
        <p id={labelId} {...stylex.props(styles.lockTitle)}>
          {transcription.canChange ? "Transcribe this meeting" : on ? "Transcription is on" : "Transcription is off"}
        </p>
        <p {...stylex.props(styles.lockNote)}>
          {transcription.asked ? "You asked a host to turn it off." : note}
        </p>
      </div>
      {transcription.canChange ? (
        <Switch
          checked={on}
          pending={transcription.pending}
          onCheckedChange={transcription.onChange}
          aria-labelledby={labelId}
        />
      ) : on ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={transcription.asked ? transcription.onTakeBack : transcription.onAsk}
          aria-describedby={labelId}
        >
          {transcription.asked ? "Take back" : "Ask to stop"}
        </Button>
      ) : null}
    </div>
  );
}

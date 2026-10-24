import * as React from "react";
import { MessageSquareLock, ShieldCheck, ShieldPlus, UserMinus } from "lucide-react";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { scrim } from "@orbmeet/ui/tokens/wash.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Tooltip,
  dialogLayout,
} from "@orbmeet/ui/react";
import type { MeetingRole } from "@/modules/meetings/contract/constants";

/** Someone in the room, as far as what may be done to them is concerned. */
export interface ManagedParticipant {
  id: string;
  name: string;
  role: MeetingRole;
  isGuest?: boolean;
}

/** What the viewer may do to other people, and the actions that do it. */
export interface ParticipantManagement {
  currentUserId?: string;
  /** A host: may make and unmake moderators. */
  canManageModerators?: boolean;
  moderatorUpdatePending?: ReadonlySet<string>;
  onSetModerator?: (participantIdentity: string, moderator: boolean) => void;
  /** A moderator: may remove attendees, and a host moderators too. */
  canRemoveParticipants?: boolean;
  removalPending?: ReadonlySet<string>;
  onRemoveParticipant?: (participantIdentity: string) => void;
  /** Anyone: opens a private thread with this person in the Timeline. */
  onMessagePrivately?: (participant: { id: string; name: string }) => void;
}

export function canMessagePrivately(participant: ManagedParticipant, management: ParticipantManagement): boolean {
  return Boolean(management.onMessagePrivately) && participant.id !== management.currentUserId;
}

/** The room enforces the same rules: nobody removes a host, and only a host removes a moderator. */
export function canRemoveParticipant(participant: ManagedParticipant, management: ParticipantManagement): boolean {
  return (
    Boolean(management.canRemoveParticipants) &&
    Boolean(management.onRemoveParticipant) &&
    participant.id !== management.currentUserId &&
    participant.role !== "host" &&
    (participant.role !== "moderator" || Boolean(management.canManageModerators))
  );
}

export function canChangeModerator(participant: ManagedParticipant, management: ParticipantManagement): boolean {
  return (
    Boolean(management.canManageModerators) &&
    Boolean(management.onSetModerator) &&
    participant.id !== management.currentUserId &&
    participant.role !== "host"
  );
}

/**
 * Removal asks first: it takes someone out of a meeting they cannot rejoin,
 * so one stray tap must not do it.
 */
function RemoveParticipantDialog({
  participant,
  onCancel,
  onConfirm,
}: {
  participant: ManagedParticipant | null;
  onCancel: () => void;
  onConfirm: (participant: ManagedParticipant) => void;
}) {
  return (
    <Dialog open={participant !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent size="sm">
        <DialogBody sx={dialogLayout.padded}>
          <DialogTitle>Remove {participant?.name || "this participant"}?</DialogTitle>
          <DialogDescription>
            {participant?.isGuest
              ? "They'll be taken out of the meeting, and guests on their network can't rejoin it. People who sign in still can."
              : "They'll be taken out of the meeting and can't rejoin it."}
          </DialogDescription>
          <div {...stylex.props(dialogLayout.actions)}>
            <DialogClose render={<Button variant="secondary" size="sm" />}>Cancel</DialogClose>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (participant) onConfirm(participant);
              }}
            >
              Remove
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * With a pointer the actions appear on hover, as a light chip. A touch screen
 * has no hover, so they stay on the video, and there they take the camera
 * switch's dark glass: a bright white square read as a status badge.
 */
const styles = stylex.create({
  group: {
    display: "flex",
    gap: 2,
    borderRadius: radii.control,
    padding: 2,
    backgroundColor: { default: scrim.backdrop, [env.hoverable]: surface.raised },
    boxShadow: { default: "none", [env.hoverable]: shadows.chip },
  },
  action: {
    display: "grid",
    height: 26,
    width: 26,
    placeItems: "center",
    borderWidth: 0,
    borderRadius: radii.field,
    cursor: { default: "pointer", ":disabled": "wait" },
    opacity: { default: 1, ":disabled": 0.5 },
    color: { default: ink.onDark, [env.hoverable]: { default: neutral.n600, ":hover": neutral.n900 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  remove: {
    color: { default: ink.onDark, [env.hoverable]: { default: neutral.n600, ":hover": danger.d600 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": danger.d50 } },
  },
});

/**
 * What the viewer may do from someone's face: write to them privately, and —
 * for a host or moderator — the same two management actions the people list
 * offers, as icons on the tile, so managing someone does not mean switching
 * from their face to a list of names.
 *
 * Renders nothing when the viewer may do nothing to this person.
 */
function ParticipantTileActions({
  participant,
  management,
  onRequestRemoval,
}: {
  participant: ManagedParticipant;
  management: ParticipantManagement;
  onRequestRemoval: (participant: ManagedParticipant) => void;
}) {
  const name = participant.name || "participant";
  const showMessage = canMessagePrivately(participant, management);
  const showModerator = canChangeModerator(participant, management);
  const showRemove = canRemoveParticipant(participant, management);
  if (!showMessage && !showModerator && !showRemove) return null;
  const isModerator = participant.role === "moderator";
  const moderatorLabel = isModerator ? `Remove ${name} as moderator` : `Make ${name} a moderator`;
  return (
    <div {...stylex.props(styles.group)}>
      {showMessage && (
        <Tooltip content="Message privately" side="bottom">
          <button
            type="button"
            aria-label={`Message ${name} privately`}
            onClick={() => management.onMessagePrivately?.({ id: participant.id, name: participant.name || "Participant" })}
            {...stylex.props(pressable.base, motion.tint, focus.ring, styles.action)}
          >
            <MessageSquareLock size={14} />
          </button>
        </Tooltip>
      )}
      {showModerator && (
        <Tooltip content={moderatorLabel} side="bottom">
          <button
            type="button"
            aria-label={moderatorLabel}
            aria-pressed={isModerator}
            disabled={management.moderatorUpdatePending?.has(participant.id) ?? false}
            onClick={() => management.onSetModerator?.(participant.id, !isModerator)}
            {...stylex.props(pressable.base, motion.tint, focus.ring, styles.action)}
          >
            {isModerator ? <ShieldCheck size={14} /> : <ShieldPlus size={14} />}
          </button>
        </Tooltip>
      )}
      {showRemove && (
        <Tooltip content="Remove from meeting" side="bottom">
          <button
            type="button"
            aria-label={`Remove ${name} from meeting`}
            disabled={management.removalPending?.has(participant.id) ?? false}
            onClick={() => onRequestRemoval(participant)}
            {...stylex.props(pressable.base, motion.tint, focus.ring, styles.action, styles.remove)}
          >
            <UserMinus size={14} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/** The confirmation every removal goes through, as state a panel can hold. */
export function useRemovalConfirmation(onRemoveParticipant?: (participantIdentity: string) => void) {
  const [confirming, setConfirming] = React.useState<ManagedParticipant | null>(null);
  const dialog = (
    <RemoveParticipantDialog
      participant={confirming}
      onCancel={() => setConfirming(null)}
      onConfirm={(participant) => {
        onRemoveParticipant?.(participant.id);
        setConfirming(null);
      }}
    />
  );
  return { requestRemoval: setConfirming, dialog };
}

/**
 * The actions on everyone else's face, wherever faces
 * are — the Talk gallery, the column beside content — and the one removal
 * confirmation they share. Render `dialog` once.
 */
export function useParticipantTileActions(
  participants: readonly ManagedParticipant[],
  management: ParticipantManagement,
) {
  const { requestRemoval, dialog } = useRemovalConfirmation(management.onRemoveParticipant);
  const byId = React.useMemo(
    () => new Map(participants.map((participant) => [participant.id, participant])),
    [participants],
  );
  const renderTileActions = React.useCallback(
    (identity: string) => {
      const participant = byId.get(identity);
      if (!participant) return null;
      return (
        <ParticipantTileActions participant={participant} management={management} onRequestRemoval={requestRemoval} />
      );
    },
    [byId, management, requestRemoval],
  );
  return { renderTileActions, dialog };
}

import { Avatar } from "@orbmeet/ui/react";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion, pressable, stack } from "@orbmeet/ui/styles/atoms";
import { blur } from "@orbmeet/ui/styles/surfaces";
import { accent, ink, neutral, surface, violet, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Monitor, SquarePen, UserPlus } from "lucide-react";

import type { HostPermissionRequest } from "@/modules/meetings/client/use-live-meeting";
import { glass } from "@orbmeet/ui/tokens/wash.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";

const styles = stylex.create({
  /**
   * A count, only when there is more than one. A single card is already
   * self-describing, and a "Requests" header above it spent a whole row of the
   * board saying what the card below it says better.
   */
  count: {
    alignSelf: "center",
    borderRadius: radii.pill,
    backgroundColor: `color-mix(in oklab, ${surface.inverse} 85%, transparent)`,
    paddingInline: space.s2_5,
    paddingBlock: space.s0_5,
    fontVariantNumeric: "tabular-nums",
    fontSize: text.xs2,
    fontWeight: weight.medium,
    color: ink.onDark,
  },

  card: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    borderRadius: radii.panel,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    backgroundColor: glass.opaque,
    padding: space.s2_5,
    boxShadow: shadows.lift3,
  },

  portrait: { position: "relative", flexShrink: 0 },
  /** A badge on the avatar saying what is being asked for, tinted by kind. */
  kindBadge: {
    position: "absolute",
    right: -4,
    bottom: -4,
    display: "grid",
    height: 20,
    width: 20,
    placeItems: "center",
    borderRadius: radii.pill,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: surface.raised,
  },
  /**
   * Violet, so the three kinds actually read as three. This pair was Tailwind's
   * `sky-50`/`sky-600`, and `sky-50` (`#f0f9ff`) is all but indistinguishable
   * from `accent.a50` (`#eef5ff`) — the screen-share and admission badges sat
   * on the same ground and differed only in icon and a slightly cooler ink.
   */
  kindScreen: { backgroundColor: violet.v50, color: violet.v700 },
  kindAdmission: { backgroundColor: accent.a50, color: accent.a700 },
  kindExtension: { backgroundColor: warning.w50, color: warning.w700 },

  body: { minWidth: 0, flexGrow: 1 },
  nameRow: { display: "flex", alignItems: "baseline", gap: space.s1_5 },
  name: { fontSize: text.sm, fontWeight: weight.semibold, color: ink.strong },
  /**
   * "Guest" is a fact about how someone joined, sitting next to their name —
   * never a replacement for it, or three guests in a room would produce three
   * identical cards with no way to tell which one is asking.
   */
  guestTag: {
    flexShrink: 0,
    borderRadius: radii.pill,
    backgroundColor: neutral.n100,
    paddingInline: space.s1_5,
    fontVariantNumeric: "tabular-nums",
    fontSize: text.xs3,
    fontWeight: weight.medium,
    letterSpacing: tracking.wide,
    textTransform: "uppercase",
    color: ink.muted,
  },
  what: { fontSize: text.xs, color: neutral.n600 },
  where: { fontSize: text.xs2, color: ink.muted },

  actions: { display: "flex", flexShrink: 0, alignItems: "center", gap: space.s1_5 },
  action: {
    borderWidth: 0,
    borderRadius: radii.control,
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
    fontFamily: "inherit",
    fontSize: text.xs,
    // A pending decision is `wait`, not `not-allowed`: the request has been
    // sent and the answer is on its way, which is a different thing from being
    // refused the control.
    cursor: { default: "pointer", ":disabled": "wait" },
    opacity: { default: 1, ":disabled": 0.5 },
  },
  deny: {
    backgroundColor: { default: neutral.n50, [env.hoverable]: { default: neutral.n50, ":hover:not(:disabled)": neutral.n100 } },
    fontWeight: weight.medium,
    color: { default: neutral.n600, [env.hoverable]: { default: neutral.n600, ":hover:not(:disabled)": ink.strong } },
  },
  approve: {
    backgroundColor: { default: accent.a600, [env.hoverable]: { default: accent.a600, ":hover:not(:disabled)": accent.a700 } },
    fontWeight: weight.semibold,
    color: ink.onAccent,
    boxShadow: `0 6px 16px -6px color-mix(in oklab, ${accent.a600} 50%, transparent)`,
  },
});

/**
 * Who is asking, for what, and how they got here.
 *
 * The card leads with a person, not a permission. The shipped version led with
 * a "Requests" header and a name that was frequently the literal word "Guest"
 * — three guests in a room produced three identical cards and no way to tell
 * which one was asking. The name is now the admission's own display name (see
 * `resolveGuestCallerIdentity`), and the line under it says where the person
 * came from, so a host can approve on what they can see.
 */
export function HostPermissionDock({
  requests,
  onApproveScreenShare,
  onDenyScreenShare,
  onApproveAdmission,
  onDenyAdmission,
  onApproveExtraPermission,
  onDenyExtraPermission,
}: {
  requests: HostPermissionRequest[];
  onApproveScreenShare: (userId: string) => void;
  onDenyScreenShare: (userId: string) => void;
  onApproveAdmission: (admissionId: string) => void;
  onDenyAdmission: (admissionId: string) => void;
  /** An extension's request, by its own `id`: an extension may ask for several things. */
  onApproveExtraPermission?: (requestId: string) => void;
  onDenyExtraPermission?: (requestId: string) => void;
}) {
  if (requests.length === 0) return null;

  return (
    <div {...stylex.props(stack.x2)}>
      {requests.length > 1 && (
        <div {...stylex.props(styles.count, blur.md)}>
          {requests.length} requests
        </div>
      )}

      {requests.map((request) => {
        const isScreenShare = request.kind === "screen-share";
        const isAdmission = request.kind === "meeting-admission";
        const isGuest =
          request.kind === "meeting-admission"
            ? request.userId === null
            : request.kind === "extension"
              ? (request.guest ?? false)
              : false;

        const icon = isScreenShare ? (
          <Monitor size={14} strokeWidth={2} />
        ) : isAdmission ? (
          <UserPlus size={14} strokeWidth={2} />
        ) : (
          <SquarePen size={14} strokeWidth={2} />
        );

        // Extension requests carry their own copy; the meeting only owns the
        // wording for its native request kinds.
        const description = isScreenShare
          ? "Wants to present their screen"
          : isAdmission
            ? "Waiting to be let in"
            : request.description;

        // Where the person is, in one line. "Guest" is a fact about how they
        // joined, next to their name — never a replacement for it.
        const context = isAdmission
          ? isGuest
            ? `Guest · joining as ${request.role}`
            : `Signed in · joining as ${request.role}`
          : isGuest
            ? "Guest · already in the meeting"
            : "In the meeting";

        const actionLabel = isScreenShare
          ? "screen share"
          : isAdmission
            ? "meeting admission"
            : request.actionLabel;

        const handleDeny = () => {
          if (isScreenShare) {
            onDenyScreenShare(request.userId);
            return;
          }
          if (isAdmission) {
            onDenyAdmission(request.admissionId);
            return;
          }
          onDenyExtraPermission?.(request.id);
        };
        const handleApprove = () => {
          if (isScreenShare) {
            onApproveScreenShare(request.userId);
            return;
          }
          if (isAdmission) {
            onApproveAdmission(request.admissionId);
            return;
          }
          onApproveExtraPermission?.(request.id);
        };

        return (
          <div
            key={request.id}
            {...stylex.props(styles.card, enter.headerPill, blur.xl)}
          >
            <div {...stylex.props(styles.portrait)}>
              <Avatar name={request.userName} size="sm" />
              <span
                aria-hidden="true"
                {...stylex.props(
                  styles.kindBadge,
                  isScreenShare
                    ? styles.kindScreen
                    : isAdmission
                      ? styles.kindAdmission
                      : styles.kindExtension,
                )}
              >
                {icon}
              </span>
            </div>

            <div {...stylex.props(styles.body)}>
              <div {...stylex.props(styles.nameRow)}>
                <span {...stylex.props(styles.name, layout.truncate)}>{request.userName}</span>
                {isGuest && <span {...stylex.props(styles.guestTag)}>Guest</span>}
              </div>
              <div {...stylex.props(styles.what, layout.truncate)}>{description}</div>
              <div {...stylex.props(styles.where, layout.truncate)}>{context}</div>
            </div>

            <div {...stylex.props(styles.actions)}>
              <button
                type="button"
                aria-label={`Deny ${actionLabel} for ${request.userName}`}
                onClick={handleDeny}
                disabled={request.decisionPending}
                {...stylex.props(pressable.base, motion.tint, focus.ring, styles.action, styles.deny)}
              >
                Deny
              </button>
              <button
                type="button"
                aria-label={`Approve ${actionLabel} for ${request.userName}`}
                onClick={handleApprove}
                disabled={request.decisionPending}
                {...stylex.props(pressable.base, motion.tint, focus.ring, styles.action, styles.approve)}
              >
                Approve
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

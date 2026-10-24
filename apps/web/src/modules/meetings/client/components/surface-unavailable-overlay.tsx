import { spinner } from "@orbmeet/ui/styles/animations";
import { motion, pressable } from "@orbmeet/ui/styles/atoms";
import { surfaces } from "@orbmeet/ui/styles/surfaces";
import { accent, danger, ink, neutral, surface, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { inkWash } from "@orbmeet/ui/tokens/wash.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";

const styles = stylex.create({
  scrim: {
    position: "absolute",
    inset: 0,
    zIndex: zIndex.modal,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: surface.canvas,
  },
  card: {
    marginInline: space.s6,
    width: "100%",
    maxWidth: "24rem",
    padding: space.s8,
    textAlign: "center",
  },

  /** A round tinted disc for a warning glyph. */
  disc: {
    marginInline: "auto",
    marginBottom: space.s4,
    display: "flex",
    height: 48,
    width: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
  },
  discWarning: { backgroundColor: warning.w100, color: warning.w600 },
  discDanger: { backgroundColor: danger.d100, color: danger.d500 },
  glyph: { height: 24, width: 24 },

  /** A larger, softer tile for the spinner — this state is not an error. */
  tile: {
    marginInline: "auto",
    marginBottom: space.s5,
    display: "flex",
    height: 64,
    width: 64,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.panel,
    backgroundImage: `linear-gradient(to bottom right, ${accent.a50}, ${accent.a100})`,
    boxShadow: `0 1px 2px ${inkWash.x06}`,
  },

  title: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.base,
    fontWeight: weight.semibold,
    color: neutral.n800,
  },
  body: {
    marginTop: space.s2,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.muted,
  },
  dismiss: {
    marginTop: space.s5,
    borderWidth: 0,
    borderRadius: radii.control,
    backgroundColor: { default: neutral.n100, [env.hoverable]: { default: neutral.n100, ":hover": neutral.n200 } },
    paddingInline: space.s5,
    paddingBlock: space.s2_5,
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: neutral.n700,
  },
});

/**
 * What the room shows when the shared Whiteboard cannot be opened.
 *
 * Every branch offers a way to carry on without it. A meeting is happening;
 * losing the board is a degraded surface, never a dead end, so "Continue
 * meeting" is present on each failure and the copy says what was lost rather
 * than what went wrong.
 */
export function SurfaceUnavailableOverlay({
  disabledByConfig,
  disabledReason,
  reconnecting,
  error,
  onClose,
}: {
  disabledByConfig?: boolean;
  disabledReason?: string | null;
  reconnecting?: boolean;
  error?: boolean;
  onClose?: () => void;
}) {
  const dismiss = (
    <button
      type="button"
      onClick={() => onClose?.()}
      {...stylex.props(pressable.base, motion.tint, styles.dismiss)}
    >
      Continue meeting
    </button>
  );

  return (
    <div {...stylex.props(styles.scrim)}>
      <div {...stylex.props(surfaces.glassSoft, styles.card)}>
        {disabledByConfig ? (
          <>
            <div {...stylex.props(styles.disc, styles.discWarning)}>
              <WarningGlyph />
            </div>
            <p {...stylex.props(styles.title)}>Whiteboard unavailable</p>
            <p {...stylex.props(styles.body)}>
              {disabledReason || "Continuing without the shared Whiteboard."}
            </p>
            {dismiss}
          </>
        ) : reconnecting ? (
          <>
            <div {...stylex.props(styles.tile)}>
              <div {...stylex.props(spinner.ring, spinner.brand, spinner.xl)} />
            </div>
            <p {...stylex.props(styles.title)}>Reconnecting whiteboard…</p>
            <p {...stylex.props(styles.body)}>
              Keeping the whiteboard open while the sync service recovers.
            </p>
            {dismiss}
          </>
        ) : error ? (
          <>
            <div {...stylex.props(styles.disc, styles.discDanger)}>
              <WarningGlyph />
            </div>
            <p {...stylex.props(styles.title)}>Whiteboard unavailable</p>
            <p {...stylex.props(styles.body)}>Continuing without the whiteboard.</p>
            {dismiss}
          </>
        ) : (
          <>
            <div {...stylex.props(styles.tile)}>
              <div {...stylex.props(spinner.ring, spinner.brand, spinner.xl)} />
            </div>
            <p {...stylex.props(styles.title)}>Opening whiteboard…</p>
          </>
        )}
      </div>
    </div>
  );
}

function WarningGlyph() {
  return (
    <svg
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
      {...stylex.props(styles.glyph)}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
      />
    </svg>
  );
}

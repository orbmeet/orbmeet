import { blur } from "@orbmeet/ui/styles/surfaces";
import { focus, layout, motion } from "@orbmeet/ui/styles/atoms";
import { accent, border, ink, neutral, record, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { glass } from "@orbmeet/ui/tokens/wash.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useDocumentTitle } from "@/app/shell/use-document-title";
import { sessionQueryOptions } from "@/app/query-client/queries/session";

const styles = stylex.create({
  screen: {
    position: "relative",
    display: "flex",
    minHeight: "100dvh",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    paddingInline: space.s5,
    backgroundColor: surface.canvas,
  },
  /** A faint rose wash behind the card — the only colour on a dead end. */
  wash: {
    position: "absolute",
    top: "50%",
    left: "50%",
    height: 600,
    width: 600,
    transform: "translate(-50%, -50%)",
    borderRadius: radii.pill,
    backgroundImage:
      `radial-gradient(circle, color-mix(in oklab, ${record.r500} 5%, transparent) 0%, transparent 70%)`,
    filter: "blur(80px)",
  },
  card: {
    position: "relative",
    width: "100%",
    maxWidth: "28rem",
    borderRadius: radii.panel,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${border.base} 80%, transparent)`,
    backgroundColor: glass.solid,
    paddingInline: { default: space.s6, [bp.sm]: space.s10 },
    paddingBlock: "2.25rem",
    textAlign: "center",
    boxShadow: shadows.elevated,
  },
  /** The quiet label above the headline — "404", "Invitation", "Meeting". */
  eyebrow: {
    margin: 0,
    marginBottom: space.s2,
    fontSize: text.xs,
    lineHeight: leading.xs,
    fontWeight: weight.semibold,
    letterSpacing: tracking.wide,
    textTransform: "uppercase",
    color: ink.muted,
  },
  title: {
    margin: 0,
    fontSize: text.xl,
    lineHeight: leading.xl,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tight,
    color: neutral.n800,
  },
  body: {
    marginTop: space.s3,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.muted,
  },
  actions: {
    marginTop: space.s6,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s3,
  },
  home: {
    display: "inline-flex",
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    backgroundColor: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    paddingInline: space.s4,
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: ink.onAccent,
    textDecorationLine: "none",
  },
  secondary: {
    display: "inline-flex",
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: border.base, [env.hoverable]: { default: border.base, ":hover": border.strong } },
    backgroundColor: surface.raised,
    paddingInline: space.s4,
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: { default: ink.muted, [env.hoverable]: { default: ink.muted, ":hover": ink.strong } },
    textDecorationLine: "none",
  },
});

export interface DeadEndProps {
  /** Small uppercase label naming what kind of dead end this is. */
  eyebrow: string;
  title: string;
  body: ReactNode;
  /**
   * Sets `document.title` while this is on screen. The 404 and the two
   * not-found states are rendered by `notFoundComponent`, which is below the
   * matched route's `head` — there is no route left to describe them, so the
   * tab would otherwise keep the generic site title.
   */
  documentTitle: string;
  /** An extra route out, beside the primary one. */
  secondaryAction?: { to: string; label: string };
  /** Optional in-place recovery control specific to this dead end. */
  children?: ReactNode;
}

/**
 * The one card the app shows when a URL leads nowhere.
 *
 * There were three of these: a branded card on `/$code`, a bare "404 / Page
 * not found" on the root, and nothing at all for a malformed invite — so which
 * explanation you got depended on which route happened to reject you first. A
 * mistyped invite code is the most likely way anyone reaches any of them, and
 * it was landing on the barest one.
 */
export function DeadEnd({ eyebrow, title, body, documentTitle, secondaryAction, children }: DeadEndProps) {
  /**
   * "Home" means the workspace for someone signed in and the marketing site for
   * everyone else. The likeliest person to land here is a signed-in user who
   * fat-fingered a meeting code; a hard-coded `/` would send them to the
   * product page instead of back to their meetings.
   */
  const { data: session } = useQuery(sessionQueryOptions());
  const signedIn = Boolean(session?.user);
  const home = signedIn
    ? ({ to: "/home", label: "Back to your workspace" } as const)
    : ({ to: "/", label: "Return home" } as const);

  useDocumentTitle(documentTitle);

  return (
    <div {...stylex.props(styles.screen)}>
      <div aria-hidden {...stylex.props(styles.wash, layout.decorative)} />
      <main {...stylex.props(styles.card, blur.xl)}>
        <p {...stylex.props(styles.eyebrow)}>{eyebrow}</p>
        <h1 {...stylex.props(styles.title)}>{title}</h1>
        <p {...stylex.props(styles.body)}>{body}</p>
        {children}
        <div {...stylex.props(styles.actions)}>
          <Link to={home.to} {...stylex.props(styles.home, focus.ring, motion.tint)}>
            {home.label}
          </Link>
          {secondaryAction && (
            <Link
              to={secondaryAction.to}
              {...stylex.props(styles.secondary, focus.ring, motion.tint)}
            >
              {secondaryAction.label}
            </Link>
          )}
        </div>
      </main>
    </div>
  );
}

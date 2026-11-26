import type { ReactNode } from "react";
import { PublicFooter } from "@/app/shell/public-footer";
import { PublicNav } from "@/app/shell/public-nav";
import { MAIN_CONTENT_ID } from "@/app/shell/skip-link";
import { enter } from "@orbmeet/ui/styles/animations";
import { accent, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

const layoutStyles = stylex.create({
  page: {
    // A column, so the shared footer sinks to the bottom on a short page
    // instead of floating under the last paragraph.
    display: "flex",
    flexDirection: "column",
    minHeight: "100vh",
    // Unified with the app's canvas ground; the old neutral-50 was a one-off.
    backgroundColor: surface.canvas,
  },
  main: {
    marginInline: "auto",
    maxWidth: "48rem",
    paddingInline: space.s6,
    paddingBlock: space.s16,
  },
  title: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: "2.25rem",
    lineHeight: 1.05,
    fontWeight: weight.semibold,
    letterSpacing: "-0.045em",
    color: ink.strong,
  },
  updated: {
    marginTop: space.s2,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  body: {
    marginTop: space.s10,
    display: "flex",
    flexDirection: "column",
    gap: space.s10,
    color: neutral.n700,
    lineHeight: leading.relaxed,
  },
});

export const legalStyles = stylex.create({
  h2: {
    margin: 0,
    fontSize: text.lg,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  h3: {
    margin: 0,
    marginTop: space.s4,
    fontWeight: weight.medium,
    color: ink.strong,
  },
  para: { margin: 0, marginTop: space.s3 },
  /** A paragraph that follows its own h3 rather than an h2. */
  paraTight: { marginTop: space.s2 },
  list: {
    margin: 0,
    marginTop: space.s2,
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    listStyleType: "disc",
    paddingInlineStart: space.s6,
  },
  /** A list whose entries are whole paragraphs, not single lines. */
  listSpaced: { gap: space.s3 },
  link: {
    color: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    textDecorationLine: "underline",
    textDecorationColor: accent.a700,
    textUnderlineOffset: 2,
  },
  copyright: {
    marginTop: space.s4,
    marginBottom: 0,
    fontSize: text.sm,
    color: ink.muted,
  },
});

export function LegalLayout({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <div {...stylex.props(layoutStyles.page)}>
      <PublicNav />
      <main id={MAIN_CONTENT_ID} {...stylex.props(layoutStyles.main, enter.fade)}>
        <h1 {...stylex.props(layoutStyles.title)}>{title}</h1>
        <p {...stylex.props(layoutStyles.updated)}>
          Last updated: {lastUpdated}
        </p>
        <div {...stylex.props(layoutStyles.body)}>{children}</div>
      </main>
      <PublicFooter />
    </div>
  );
}

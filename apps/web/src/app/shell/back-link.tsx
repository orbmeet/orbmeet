import { motion } from "@orbmeet/ui/styles/atoms";
import { ink } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link, type RegisteredRouter, type ValidateLinkOptions } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

const styles = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: { default: ink.muted, [env.hoverable]: { default: ink.muted, ":hover": ink.strong } },
    textDecorationLine: "none",
  },
});

type BackLinkProps<TRouter extends RegisteredRouter = RegisteredRouter, TOptions = unknown> = {
  /** Where "back" goes. Checked against the route tree. */
  link: ValidateLinkOptions<TRouter, TOptions>;
  children: string;
};

/**
 * "← Meetings". The one way a detail page points back at its collection, so
 * the arrow, weight and hover are the same on every page that has one.
 */
export function BackLink<TRouter extends RegisteredRouter, TOptions>(
  props: BackLinkProps<TRouter, TOptions>,
): ReactNode;
export function BackLink({ link, children }: BackLinkProps) {
  return (
    <Link {...link} {...stylex.props(styles.root, motion.tint)}>
      <ArrowLeft size={16} aria-hidden />
      {children}
    </Link>
  );
}

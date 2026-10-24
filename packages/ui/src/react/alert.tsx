import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { AlertTriangle, CheckCircle, Info, XCircle } from "lucide-react";
import type { ReactNode } from "react";

import { accent, danger, success, warning } from "../tokens/colors.stylex";
import { radii } from "../tokens/radii.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";

const styles = stylex.create({
  root: {
    display: "flex",
    gap: space.s3,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    padding: space.s4,
  },
  icon: {
    marginTop: space.s0_5,
    flexShrink: 0,
  },
  body: {
    minWidth: 0,
    flexGrow: 1,
  },
  title: {
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    margin: 0,
  },
  message: {
    fontSize: text.sm,
    lineHeight: leading.sm,
  },
  messageSpaced: {
    marginTop: space.s1,
  },
});

const tones = stylex.create({
  info: { backgroundColor: accent.a50, borderColor: accent.a200, color: accent.a800 },
  success: { backgroundColor: success.s50, borderColor: success.s200, color: success.s800 },
  warning: { backgroundColor: warning.w50, borderColor: warning.w200, color: warning.w800 },
  error: { backgroundColor: danger.d50, borderColor: danger.d200, color: danger.d800 },
});

/**
 * The icon is tinted a step brighter than the text so it reads as a signal
 * rather than as part of the sentence.
 */
const iconTones = stylex.create({
  info: { color: accent.a500 },
  success: { color: success.s500 },
  warning: { color: warning.w500 },
  error: { color: danger.d500 },
});

const glyphs = {
  info: Info,
  success: CheckCircle,
  warning: AlertTriangle,
  error: XCircle,
} as const;

interface AlertProps {
  variant?: keyof typeof glyphs;
  title?: string;
  children: ReactNode;
  sx?: StyleXStyles;
}

export function Alert({ variant = "info", title, children, sx }: AlertProps) {
  const Icon = glyphs[variant];

  return (
    <div role="alert" {...stylex.props(styles.root, tones[variant], sx)}>
      <Icon size={20} {...stylex.props(styles.icon, iconTones[variant])} />
      <div {...stylex.props(styles.body)}>
        {title && <p {...stylex.props(styles.title)}>{title}</p>}
        <div {...stylex.props(styles.message, title ? styles.messageSpaced : null)}>{children}</div>
      </div>
    </div>
  );
}

import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "./button";
import { row } from "../styles/atoms";
import { danger } from "../tokens/colors.stylex";
import { radii } from "../tokens/radii.stylex";
import { space } from "../tokens/space.stylex";
import { leading, text } from "../tokens/typography.stylex";

const styles = stylex.create({
  root: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: danger.d200,
    backgroundColor: danger.d50,
    paddingInline: space.s4,
    paddingBlock: space.s3,
  },
  message: {
    margin: 0,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: danger.d700,
  },
  icon: { flexShrink: 0 },
});

interface QueryErrorNoticeProps {
  message: string;
  onRetry: () => void;
  sx?: StyleXStyles;
}

/**
 * The failure state for a query that has its own place on the page — a section
 * that could not load, rather than a route that could not.
 */
export function QueryErrorNotice({ message, onRetry, sx }: QueryErrorNoticeProps) {
  return (
    <div role="alert" {...stylex.props(row.x3, row.between, styles.root, sx)}>
      <p {...stylex.props(styles.message)}>
        <AlertTriangle size={15} {...stylex.props(styles.icon)} />
        {message}
      </p>
      <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
        <RefreshCw size={13} />
        Retry
      </Button>
    </div>
  );
}

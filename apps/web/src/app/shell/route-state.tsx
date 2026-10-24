import { Spinner } from "@orbmeet/ui/react";
import { accent, ink } from "@orbmeet/ui/tokens/colors.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
import { useEffect } from "react";

import { getSafeRouteErrorMessage } from "@/lib/error-inspection";
import { reportBoundaryError } from "@/lib/telemetry/client-errors";
import { env } from "@orbmeet/ui/tokens/media.stylex";

const styles = stylex.create({
  centered: {
    display: "flex",
    height: "16rem",
    alignItems: "center",
    justifyContent: "center",
  },
  errorBox: {
    display: "flex",
    height: "16rem",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s3,
    textAlign: "center",
  },
  message: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.muted,
  },
  retry: {
    borderWidth: 0,
    backgroundColor: "transparent",
    padding: 0,
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    cursor: "pointer",
  },
});

/** Shared pending state for authenticated route suspense boundaries. */
export function RoutePending() {
  return (
    <div {...stylex.props(styles.centered)}>
      <Spinner size="lg" brand />
    </div>
  );
}

interface RouteErrorProps {
  /** Whatever the boundary caught; React does not guarantee an `Error`. */
  error: unknown;
  reset?: () => void;
  /** Fallback message when the error has no human-readable message. */
  fallback?: string;
}

/**
 * Shared error state for authenticated route boundaries. Replaces the
 * per-route `*Error` functions that were byte-identical except for the
 * fallback string. Wires TanStack Router's `reset` together with React
 * Query's `queryErrorResetBoundary` so both caches retry on click.
 */
export function RouteError({ error, reset, fallback = "Something went wrong" }: RouteErrorProps) {
  const router = useRouter();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();

  useEffect(() => {
    queryErrorResetBoundary.reset();
  }, [queryErrorResetBoundary]);

  useEffect(() => {
    reportBoundaryError("route", error);
  }, [error]);

  return (
    <div {...stylex.props(styles.errorBox)}>
      <p {...stylex.props(styles.message)}>{getSafeRouteErrorMessage(error, fallback)}</p>
      <button
        type="button"
        onClick={() => {
          queryErrorResetBoundary.reset();
          reset?.();
          void router.invalidate();
        }}
        {...stylex.props(styles.retry)}
      >
        Retry
      </button>
    </div>
  );
}

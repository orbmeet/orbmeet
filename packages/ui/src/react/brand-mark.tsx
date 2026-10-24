import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { useId } from "react";

import { violet } from "../tokens/colors.stylex";
import { env } from "../tokens/media.stylex";

/**
 * What Orb is doing, told by the mark itself. Only the lit face moves; the
 * geometry and the two tones never change, so every state is still the logo.
 *
 *   - `rest`: the brand. Nav, footer, favicon. Never moves.
 *   - `listening`: transcription is on. The face drifts in and out, slowly,
 *     like breathing — the crescent thins and fattens.
 *   - `thinking`: Orb is working on a request. The light orbits the sphere.
 *   - `speaking`: Orb is answering. A quick pulse of the whole mark.
 */
export type BrandMarkState = "rest" | "listening" | "thinking" | "speaking";

const kfBreathe = stylex.keyframes({
  "0%, 100%": { transform: "translate(0, 0)" },
  "50%": { transform: "translate(2.4px, 2.4px)" },
});

const kfOrbit = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

const kfSpeak = stylex.keyframes({
  "0%, 100%": { transform: "scale(1)" },
  "25%": { transform: "scale(1.07)" },
  "55%": { transform: "scale(0.97)" },
  "75%": { transform: "scale(1.04)" },
});

const REDUCED = env.reducedMotion;

const styles = stylex.create({
  root: { display: "block", flexShrink: 0 },
  /** The sphere's shaded side, which shows as the crescent. */
  shade: { fill: violet.v600 },
  /** The lit face, set up and to the left of the shade. */
  face: { fill: violet.v400, transformBox: "view-box", transformOrigin: "16px 16px" },
  // Listening and speaking are decoration: with reduced motion they park on
  // the resting mark, which still reads as the logo.
  listening: {
    animationName: { default: kfBreathe, [REDUCED]: "none" },
    animationDuration: "2.6s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  // Thinking is progress — Orb is working — so it keeps turning, like a spinner.
  thinking: {
    animationName: kfOrbit,
    animationDuration: "1.6s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  speakingFace: {
    animationName: { default: kfBreathe, [REDUCED]: "none" },
    animationDuration: "0.55s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  speakingRoot: {
    transformOrigin: "center",
    animationName: { default: kfSpeak, [REDUCED]: "none" },
    animationDuration: "1.1s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
});

interface BrandMarkProps {
  /** Rendered edge length in px. */
  size?: number;
  /** Accessible name. Omit when the wordmark sits next to the mark. */
  title?: string;
  /**
   * What Orb is doing. Defaults to `rest`. The state is shown, never only
   * told: whoever renders a moving mark also says the state in words nearby.
   */
  state?: BrandMarkState;
  sx?: StyleXStyles;
}

/**
 * The Orb Meet mark: the orb, a violet sphere lit from the upper left, its
 * shaded side a crescent along the lower right. Two flat tones rather than a
 * gradient, so it holds together at a tab's 16px as well as on a home screen.
 *
 * The lit face is the same circle moved 5.5 units up and left of the shade
 * (in a 32-unit box) and clipped to it: about 40% of the radius, which is
 * what keeps the crescent visible at 16px without turning the sphere into a
 * moon. The clip sits on a group around the face, so the face can move under
 * it without the clip moving too.
 *
 * Drawn inline rather than loaded as an image so it is crisp at every size
 * and costs no request. `public/favicon.svg` and the PWA and Apple icons are
 * exported from the same geometry.
 */
export function BrandMark({ size = 28, title, state = "rest", sx }: BrandMarkProps) {
  const clipId = useId();
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      {...stylex.props(styles.root, state === "speaking" && styles.speakingRoot, sx)}
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="16" cy="16" r="14" />
        </clipPath>
      </defs>
      <circle cx="16" cy="16" r="14" {...stylex.props(styles.shade)} />
      <g clipPath={`url(#${clipId})`}>
        <circle
          cx="10.5"
          cy="10.5"
          r="14"
          {...stylex.props(
            styles.face,
            state === "listening" && styles.listening,
            state === "thinking" && styles.thinking,
            state === "speaking" && styles.speakingFace,
          )}
        />
      </g>
    </svg>
  );
}

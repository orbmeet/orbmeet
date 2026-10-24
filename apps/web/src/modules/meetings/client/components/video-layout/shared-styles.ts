import * as stylex from "@stylexjs/stylex";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";

/** Styles shared by more than one video-layout file. */
export const shared = stylex.create({
  /** The camera switcher's corner, quiet until hovered. */
  cameraCorner: {
    position: "absolute",
    right: space.s3,
    top: space.s3,
    zIndex: zIndex.meetingPanel,
    opacity: { default: 0.7, [env.hoverable]: { default: 0.7, ":hover": 1 } },
    transitionProperty: "opacity",
    transitionDuration: { default: "200ms", [env.reducedMotion]: "0s" },
  },
  /** "Waiting for participants": the room is honest about being empty. */
  emptyStage: {
    display: "flex",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    padding: space.s8,
  },
  /**
   * Live voice-reactive halo, driven by the `--voice` CSS variable (0..1) that
   * {@link useVoiceGlow} writes onto each tile every animation frame. Expressed
   * as an accent glow appended to the tile's own box-shadow — an element's box-shadow
   * is painted outside its border box and is not clipped by its own
   * `overflow-hidden`, so no extra wrapper is needed. `--voice` defaults to 0, so
   * the halo is invisible until someone speaks.
   */
  haloTransition: {
    transitionProperty: "box-shadow",
    transitionDuration: { default: "120ms", [env.reducedMotion]: "0s" },
    transitionTimingFunction: "linear",
  },
});

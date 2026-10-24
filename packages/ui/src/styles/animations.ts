/**
 * Every animation in the app, as ready-to-apply styles.
 *
 * The keyframes themselves are deliberately *not* exported. StyleX can only
 * resolve imported values from `.stylex.ts` token files, so a `@keyframes`
 * name cannot cross a module boundary — but a `stylex.create()` namespace can.
 * Exporting the finished style rather than the raw keyframe turns that
 * constraint into the better API anyway: an animation arrives with its
 * duration, curve, iteration count *and* its reduced-motion policy already
 * decided, so no call site can apply the fade at the wrong speed or forget to
 * park it.
 *
 * ## Reduced motion
 *
 * The old stylesheet carried a blanket
 * `* { animation-duration: 0.01ms !important }` rule and then fought it: the
 * spinners needed an unlayered `!important` override to keep turning, and
 * every looping decoration had to be parked by hand because collapsing its
 * cycle to nothing left it stopped on a keyframe that is deliberately
 * invisible.
 *
 * There is no blanket rule here. Each animation below states what it does when
 * motion is reduced, and the three answers are:
 *
 *   - **Entrances** stop. The element is simply present.
 *   - **Decoration** stops, parked at its visible resting state.
 *   - **Progress indicators keep running.** A spinner means "working"; frozen
 *     at frame 0 it reads as a hung app.
 */
import * as stylex from "@stylexjs/stylex";

import { accent, border } from "../tokens/colors.stylex";
import { duration, easing } from "../tokens/motion.stylex";
import { env } from "../tokens/media.stylex";

const REDUCED = env.reducedMotion;

/* ── Keyframes (private) ────────────────────────────────────────────────── */

const kfFadeIn = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const kfFadeInUp = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(30px)" },
  to: { opacity: 1, transform: "translateY(0)" },
});

const kfQuantumIn = stylex.keyframes({
  from: { opacity: 0, transform: "scale(0.9) translateY(20px)", filter: "blur(10px)" },
  to: { opacity: 1, transform: "scale(1) translateY(0)", filter: "blur(0px)" },
});

const kfPanelSlideIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateX(16px)" },
  to: { opacity: 1, transform: "translateX(0)" },
});

const kfHeaderPillIn = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(-8px) scale(0.96)" },
  to: { opacity: 1, transform: "translateY(0) scale(1)" },
});

const kfSpin = stylex.keyframes({
  from: { transform: "rotate(0deg)" },
  to: { transform: "rotate(360deg)" },
});

const kfPulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.5 },
});

const kfBounceDot = stylex.keyframes({
  "0%, 100%": { transform: "translateY(0)" },
  "50%": { transform: "translateY(-4px)" },
});

const kfPing = stylex.keyframes({
  "75%, 100%": { transform: "scale(2)", opacity: 0 },
});

const kfPulseGlow = stylex.keyframes({
  "0%, 100%": { opacity: 0.6, transform: "scale(1)" },
  "50%": { opacity: 1, transform: "scale(1.05)" },
});

const kfBlob = stylex.keyframes({
  "0%": { transform: "translate(0px, 0px) scale(1)" },
  "33%": { transform: "translate(40px, -60px) scale(1.1)" },
  "66%": { transform: "translate(-30px, 30px) scale(0.9)" },
  "100%": { transform: "translate(0px, 0px) scale(1)" },
});

const kfOrbDrift1 = stylex.keyframes({
  "0%": { transform: "translate(0%, 0%) scale(1)", opacity: 0.55 },
  "30%": { transform: "translate(8%, -12%) scale(1.12)", opacity: 0.7 },
  "60%": { transform: "translate(-6%, 8%) scale(0.92)", opacity: 0.5 },
  "100%": { transform: "translate(0%, 0%) scale(1)", opacity: 0.55 },
});

const kfOrbDrift2 = stylex.keyframes({
  "0%": { transform: "translate(0%, 0%) scale(1)", opacity: 0.45 },
  "40%": { transform: "translate(-10%, 6%) scale(1.08)", opacity: 0.6 },
  "70%": { transform: "translate(5%, -10%) scale(0.9)", opacity: 0.4 },
  "100%": { transform: "translate(0%, 0%) scale(1)", opacity: 0.45 },
});

const kfOrbDrift3 = stylex.keyframes({
  "0%": { transform: "translate(0%, 0%) scale(1)", opacity: 0.4 },
  "50%": { transform: "translate(6%, 10%) scale(1.15)", opacity: 0.55 },
  "100%": { transform: "translate(0%, 0%) scale(1)", opacity: 0.4 },
});

const kfEq1 = stylex.keyframes({
  "0%, 100%": { height: 4 },
  "25%": { height: 14 },
  "60%": { height: 7 },
});
const kfEq2 = stylex.keyframes({
  "0%, 100%": { height: 10 },
  "35%": { height: 4 },
  "70%": { height: 16 },
});
const kfEq3 = stylex.keyframes({
  "0%, 100%": { height: 6 },
  "45%": { height: 14 },
  "80%": { height: 4 },
});
const kfEq4 = stylex.keyframes({
  "0%, 100%": { height: 14 },
  "20%": { height: 5 },
  "55%": { height: 12 },
});
const kfEq5 = stylex.keyframes({
  "0%, 100%": { height: 7 },
  "40%": { height: 16 },
  "75%": { height: 4 },
});

/* ── Entrances ──────────────────────────────────────────────────────────── */

/**
 * Something arriving. All of these are `both`-filled, so the element holds its
 * starting frame until the animation runs — which is what makes a staggered
 * delay look intentional rather than like a flash of unstyled content.
 *
 * Under reduced motion each one resolves to no animation at all, leaving the
 * element in its natural, fully visible state.
 */
export const enter = stylex.create({
  fade: {
    animationName: { default: kfFadeIn, [REDUCED]: "none" },
    animationDuration: duration.slow,
    animationTimingFunction: easing.stiff,
    animationFillMode: "both",
  },
  fadeUp: {
    animationName: { default: kfFadeInUp, [REDUCED]: "none" },
    animationDuration: "0.4s",
    animationTimingFunction: easing.gentle,
    animationFillMode: "both",
  },
  /** A surface taking over the screen: scales up out of soft focus. */
  quantum: {
    animationName: { default: kfQuantumIn, [REDUCED]: "none" },
    animationDuration: "0.6s",
    animationTimingFunction: easing.bounce,
    animationFillMode: "both",
  },
  /** A side panel arriving from the right edge. */
  panel: {
    animationName: { default: kfPanelSlideIn, [REDUCED]: "none" },
    animationDuration: "0.2s",
    animationTimingFunction: "ease-out",
    animationFillMode: "both",
  },
  /** A pill dropping into a header row. */
  headerPill: {
    animationName: { default: kfHeaderPillIn, [REDUCED]: "none" },
    animationDuration: duration.slow,
    animationTimingFunction: "ease-out",
    animationFillMode: "both",
  },
});

/**
 * Stagger. `enter.fade` plus a delay, for a list that should arrive in order.
 *
 * A function rather than a set of fixed steps because the useful delay depends
 * on how many things are arriving — six cards want 60ms apart, two want 120ms.
 */
export const stagger = stylex.create({
  by: (ms: number) => ({
    animationDelay: `${ms}ms`,
  }),
});

/* ── Progress ───────────────────────────────────────────────────────────── */

/**
 * Indicators that mean "working".
 *
 * These are the one category that keeps moving under reduced motion, on
 * purpose. Everything here is a small, steady, non-parallax rotation or
 * translation — the class of motion the preference is least about, and the
 * class whose absence actively misinforms.
 */
export const progress = stylex.create({
  spin: {
    animationName: kfSpin,
    animationDuration: "0.8s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  /**
   * An indeterminate breath, for a bar that is filling but cannot say how far.
   * Keeps running under reduced motion for the same reason `spin` does.
   */
  pulse: {
    animationName: kfPulse,
    animationDuration: "2s",
    animationTimingFunction: "cubic-bezier(0.4, 0, 0.6, 1)",
    animationIterationCount: "infinite",
  },
  /** A typing indicator dot. Pair with `stagger.by()` per dot. */
  bounceDot: {
    animationName: kfBounceDot,
    animationDuration: "1s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
});

/* ── Presence ───────────────────────────────────────────────────────────── */

/**
 * Live state: recording, speaking, connected.
 *
 * Parked under reduced motion — the state is always carried by colour and text
 * as well, so stopping the pulse loses nothing.
 */
export const presence = stylex.create({
  /**
   * The expanding ring on a live dot. Smaller and faster than `halo` — this one
   * sits inside a 6px indicator, not around a 12px record button.
   */
  ping: {
    animationName: { default: kfPing, [REDUCED]: "none" },
    animationDuration: "1s",
    animationTimingFunction: "cubic-bezier(0, 0, 0.2, 1)",
    animationIterationCount: "infinite",
    opacity: { default: null, [REDUCED]: 0.6 },
  },
});

/**
 * The five bars of a voice equaliser.
 *
 * Indexed rather than named: the caller renders five bars in a loop and reaches
 * for `eq.bar1` … `eq.bar5` by position. Five distinct keyframes rather than
 * one staggered animation because the bars have different rest heights as well
 * as different phases; a single animation offset by a delay gives every bar the
 * same silhouette a beat apart, which reads as a wave rather than a voice.
 */
export const eq = stylex.create({
  bar1: { animationName: { default: kfEq1, [REDUCED]: "none" }, animationDuration: "1.1s", animationIterationCount: "infinite", animationTimingFunction: "ease-in-out" },
  bar2: { animationName: { default: kfEq2, [REDUCED]: "none" }, animationDuration: "0.9s", animationIterationCount: "infinite", animationTimingFunction: "ease-in-out" },
  bar3: { animationName: { default: kfEq3, [REDUCED]: "none" }, animationDuration: "1.3s", animationIterationCount: "infinite", animationTimingFunction: "ease-in-out" },
  bar4: { animationName: { default: kfEq4, [REDUCED]: "none" }, animationDuration: "1s", animationIterationCount: "infinite", animationTimingFunction: "ease-in-out" },
  bar5: { animationName: { default: kfEq5, [REDUCED]: "none" }, animationDuration: "1.2s", animationIterationCount: "infinite", animationTimingFunction: "ease-in-out" },
});

/* ── Ambient decoration ─────────────────────────────────────────────────── */

/**
 * Background motion. Pure decoration, every one of it parked under reduced
 * motion at a frame where the element is still visible.
 */
export const ambient = stylex.create({
  pulseGlow: {
    animationName: { default: kfPulseGlow, [REDUCED]: "none" },
    animationDuration: "3s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    opacity: { default: null, [REDUCED]: 0.8 },
  },
  blob: {
    animationName: { default: kfBlob, [REDUCED]: "none" },
    animationDuration: "15s",
    animationIterationCount: "infinite",
    animationDirection: "alternate",
  },
  /** The three drifting orbs behind a meeting, in mount order. */
  orb1: {
    animationName: { default: kfOrbDrift1, [REDUCED]: "none" },
    animationDuration: "18s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    opacity: { default: null, [REDUCED]: 0.55 },
  },
  orb2: {
    animationName: { default: kfOrbDrift2, [REDUCED]: "none" },
    animationDuration: "22s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    opacity: { default: null, [REDUCED]: 0.45 },
  },
  orb3: {
    animationName: { default: kfOrbDrift3, [REDUCED]: "none" },
    animationDuration: "26s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    opacity: { default: null, [REDUCED]: 0.4 },
  },
});


/** Handy when a caller has to pick an equaliser bar by index. */
export const eqByIndex = [eq.bar1, eq.bar2, eq.bar3, eq.bar4, eq.bar5] as const;

/** The spinner ring itself — the geometry, not just the rotation. */
export const spinner = stylex.create({
  ring: {
    borderRadius: "50%",
    borderStyle: "solid",
    borderTopColor: accent.a600,
    animationName: kfSpin,
    animationDuration: "0.8s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  brand: { borderColor: accent.a200, borderTopColor: accent.a600 },
  neutral: { borderColor: `${border.strong}`, borderTopColor: accent.a600 },
  sm: { width: 16, height: 16, borderWidth: 1.5 },
  md: { width: 20, height: 20, borderWidth: 2 },
  lg: { width: 32, height: 32, borderWidth: 2.5 },
  xl: { width: 36, height: 36, borderWidth: 2.5 },
});

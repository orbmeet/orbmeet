/**
 * Orb Meet colour tokens — "Ink".
 *
 * Quiet neutral greys, a white card for every region, and one violet accent —
 * the orb's own colour — spent sparingly. Amber is kept for the few things the
 * whole room must notice — timers, raised hands.
 *
 * The semantic names (`accent`, `neutral`, `warning`, `primary`) are the tokens
 * components are expected to reach for, and the raw scales below them are the
 * palette those names are tuned from. Reaching past a semantic name into a raw
 * scale is a visible choice rather than the default.
 *
 * Light and dark. Every colour a theme changes is written once as
 * `light-dark(<light>, <dark>)`, and the element's `color-scheme` picks the
 * side: the document sets it from the viewer's appearance setting (see
 * `@orbmeet/ui/theme`), and a subtree that must stay light — the whiteboard's
 * paper, the meeting room until it has a dark design — pins `color-scheme:
 * light` on itself. Custom properties keep `light-dark()` unresolved until a
 * property uses them, so the pin reaches derived tokens (washes, shadows) too.
 *
 * The dark side of a scale runs the other way where it has to: the pale tints
 * a light page fills with (`50`–`200`) become deep ones, and the steps used for
 * text on them (`700` and up) become light, so "tinted chip with accent text"
 * reads the same in both. The middle steps are fills and stay put.
 */
import * as stylex from "@stylexjs/stylex";

/**
 * Structural neutrals. The app shell's greys — page ground, hairlines, body
 * copy, headings. `150` is the half-step used for hairline borders on white.
 */
export const neutral = stylex.defineVars({
  n50: "light-dark(#f7f7f9, #141419)",
  n100: "light-dark(#eeeef1, #1b1b22)",
  n150: "light-dark(#e2e2e8, #25252d)",
  n200: "light-dark(#d4d4dc, #2e2e38)",
  n300: "light-dark(#b9b9c4, #42424e)",
  n400: "light-dark(#8a8a96, #6e6c7c)",
  n500: "light-dark(#64646f, #9a98a8)",
  n600: "light-dark(#52525c, #b0aebd)",
  n700: "light-dark(#3f3f48, #c4c2d0)",
  n800: "light-dark(#26262d, #dddbe6)",
  n900: "light-dark(#16161b, #f2f1f7)",
  n950: "light-dark(#0b0b0f, #fafafc)",
});

/**
 * Interactive accent: violet, the orb's colour. Primary actions, focus rings,
 * the selected page. White on `a600` measures 6.8:1 in light and 5.0:1 in
 * dark; `a700` is the step for accent-coloured text on any ground.
 */
export const accent = stylex.defineVars({
  a50: "light-dark(#f5f3ff, #17132b)",
  a100: "light-dark(#f0ecff, #231d42)",
  a200: "light-dark(#dcd3ff, #2f2659)",
  a300: "light-dark(#beb0ff, #45388a)",
  a400: "light-dark(#9580ff, #6a57d9)",
  a500: "light-dark(#6a4cff, #7c66ff)",
  a600: "light-dark(#5838ee, #6a4cff)",
  a700: "light-dark(#4527d4, #b4a6ff)",
  a800: "light-dark(#3720a8, #cfc6ff)",
  a900: "light-dark(#2d1c82, #e4deff)",
  a950: "light-dark(#1a1050, #f3f0ff)",
});

/** Secondary accent: warm amber. Energy, creativity — and every warning state. */
export const warning = stylex.defineVars({
  w50: "light-dark(#fff8ec, #261a06)",
  w100: "light-dark(#fff2da, #33230a)",
  w200: "light-dark(#fde2ae, #4a330f)",
  w300: "#f9cc77",
  w400: "#f5b94c",
  w500: "#f0a832",
  w600: "#d98a12",
  w700: "light-dark(#a35e05, #f5b94c)",
  w800: "light-dark(#80500a, #f9cc77)",
  w900: "light-dark(#6a420b, #fde2ae)",
  w950: "light-dark(#3d2404, #fff2da)",
});

/**
 * Tertiary: soft violet. AI features, recognition, and screen-shared media —
 * the signals that are about *content* rather than about a state someone is in.
 */
export const violet = stylex.defineVars({
  v50: "light-dark(#f5f3ff, #1a1530)",
  v100: "light-dark(#ede9fe, #231d42)",
  v200: "light-dark(#ddd6fe, #2f2659)",
  v300: "light-dark(#c4b5fd, #4c3d99)",
  v400: "#a78bfa",
  v500: "#8b5cf6",
  v600: "#7c3aed",
  v700: "light-dark(#6d28d9, #c4b5fd)",
  v800: "light-dark(#5b21b6, #ddd6fe)",
  v900: "light-dark(#4c1d95, #ede9fe)",
  v950: "light-dark(#2e1065, #f5f3ff)",
});

/** Confirmations and completed actions. Distinct from `live` on purpose. */
export const success = stylex.defineVars({
  s50: "light-dark(#f0fdf4, #0c1f14)",
  s100: "light-dark(#dcfce7, #10291a)",
  s200: "light-dark(#bbf7d0, #14532d)",
  s300: "#86efac",
  s400: "#4ade80",
  s500: "#22c55e",
  s600: "#16a34a",
  s700: "light-dark(#15803d, #4ade80)",
  s800: "light-dark(#166534, #86efac)",
  s900: "light-dark(#14532d, #bbf7d0)",
});

/** Destructive actions and error states. */
export const danger = stylex.defineVars({
  d50: "light-dark(#fef2f2, #2a1010)",
  d100: "light-dark(#fee2e2, #3a1414)",
  d200: "light-dark(#fecaca, #5b1a1a)",
  d300: "#fca5a5",
  d400: "#f87171",
  d500: "#ef4444",
  d600: "#dc2626",
  d700: "light-dark(#b91c1c, #f87171)",
  d800: "light-dark(#991b1b, #fca5a5)",
  d900: "light-dark(#7f1d1d, #fecaca)",
});

/**
 * Presence: online, speaking, recording, good connection.
 *
 * Deliberately a second green, separate from `success`, so "this is happening
 * right now" and "this finished successfully" never read as the same signal.
 */
export const live = stylex.defineVars({
  l50: "light-dark(#ecfdf5, #062016)",
  l100: "light-dark(#d1fae5, #082a1d)",
  l200: "light-dark(#a7f3d0, #0b3b29)",
  l300: "#6ee7b7",
  l400: "#34d399",
  l500: "#10b981",
  l600: "#059669",
  l700: "light-dark(#047857, #34d399)",
  l800: "light-dark(#065f46, #6ee7b7)",
  l900: "light-dark(#064e3b, #a7f3d0)",
});

/**
 * Recording — rose.
 *
 * Its own scale rather than a step of `danger`, and the distinction is
 * load-bearing: a recording is a state a person is *in* while it happens, not
 * an error or a destructive action. Red would say something the interface does
 * not mean. Three sites reach for it (the output badge, the meeting row's tone
 * and chip, the entry glow), which is one more than the threshold this file
 * sets for giving a colour a name.
 */
export const record = stylex.defineVars({
  r50: "light-dark(#fff1f2, #2a0f15)",
  r500: "#f43f5e",
  r700: "light-dark(#be123c, #fb7185)",
});

/**
 * Avatar identity palette.
 *
 * A fixed, ordered *set* — `hashStringToIndex` picks one by name, so the only
 * requirements are that there are eight, that they stay visually distinct, and
 * that a given person keeps the same one. Deliberately its own thing rather
 * than borrowed steps from the brand scales, so retuning a brand accent never
 * quietly restyles a slice of everyone's initials.
 *
 * Pairs are surface + ink, chosen to clear AA for initials at these sizes. The
 * same pastels serve the dark theme: a face reads as the same person in both.
 */
export const identity = stylex.defineVars({
  surface1: "oklch(95.3% 0.051 180.801)",
  ink1: "oklch(51.1% 0.096 186.391)",
  surface2: "oklch(96.2% 0.059 95.617)",
  ink2: "oklch(55.5% 0.163 48.998)",
  surface3: "oklch(94.1% 0.03 12.58)",
  ink3: "oklch(51.4% 0.222 16.935)",
  surface4: "oklch(95.1% 0.026 236.824)",
  ink4: "oklch(50% 0.134 242.749)",
  surface5: "oklch(95% 0.052 163.051)",
  ink5: "oklch(50.8% 0.118 165.612)",
  surface6: "oklch(94.3% 0.029 294.588)",
  ink6: "oklch(49.1% 0.27 292.581)",
  surface7: "oklch(95.4% 0.038 75.164)",
  ink7: "oklch(55.3% 0.195 38.402)",
  surface8: "oklch(94.8% 0.028 342.258)",
  ink8: "oklch(52.5% 0.223 3.958)",
});

/**
 * Decorative stops — art direction, not roles.
 *
 * Hand-tuned values that sit off the scales on purpose: the cool far stop of a
 * glass gradient, the auth orb's satellites, and the warm neutrals the entry
 * and handoff screens use to read as paper rather than as the app's cool
 * canvas.
 *
 * They are named here rather than typed inline so the palette has no literals
 * hiding in it, and so re-theming can reach them — but they are deliberately
 * *not* folded into `accent` or `neutral`. Each was picked by eye against a
 * specific surface; snapping them to the nearest scale step would be a design
 * change wearing a refactor's clothes.
 */
export const decor = stylex.defineVars({
  /** The cool far stop of the glass and glassSoft gradients. */
  glassCool: "light-dark(#fafafc, #17171c)",
  glassCooler: "light-dark(#f5f5f8, #141419)",
  /** The auth orb's satellites — a cooler violet than the accent they orbit. */
  orbSky: "#a996ff",
  orbSkyLight: "#d4caff",
  /** Warm paper: the whiteboard desk, the entry card, the handoff sheet. */
  paper: "light-dark(#f2f0ec, #16151a)",
  paperWarm: "light-dark(#f7f3ee, #1a191e)",
  paperCool: "light-dark(#f7f7f6, #18181c)",
  /** The recorder's dead-screen ground — near-black, but not the scrim. */
  voidGround: "#111111",
  /**
   * The orb drawn large — Home's "your room is ready", Orb's own mark — as a
   * lit sphere: the highlight, the lit body, the turn, and the shaded limb.
   * The flat `BrandMark` stays the logo; this is the same orb as an object.
   */
  orbHighlight: "#f4f1ff",
  orbLit: "#b2a1ff",
  orbBody: "#6646ff",
  orbShade: "#2a1191",
});

/**
 * Space tile gradients.
 *
 * A fixed, ordered set of six two-stop gradients, picked by name hash exactly
 * like `identity` — so a Space keeps its colour everywhere it appears.
 *
 * Tokenised for the same reason `identity` was. Three of these gradients used
 * to interpolate a brand token (`violet.v500`, `warning.w400`, `live.l500`)
 * while the other three were raw hex, which meant re-tuning the AI accent
 * quietly restyled half the Spaces grid and left the rest where it was. All
 * twelve stops now move together, or not at all.
 *
 * Values are carried over unchanged; reordering the pairs re-colours every
 * existing Space.
 */
export const spaceTile = stylex.defineVars({
  from1: "#8b5cf6",
  to1: "#d946ef",
  from2: "#fbbf24",
  to2: "#fb7185",
  from3: "#2dd4bf",
  to3: "#10b981",
  from4: "#38bdf8",
  to4: "#6366f1",
  from5: "#fb7185",
  to5: "#fb923c",
  from6: "#818cf8",
  to6: "#22d3ee",
});

/**
 * Semantic surfaces and ink.
 *
 * This is the group most component code should be reaching for. The scales
 * above exist so these can be tuned; a component that names `surface.card` and
 * `ink.body` keeps working when the palette moves under it, and one that names
 * `neutral.n700` does not.
 */
export const surface = stylex.defineVars({
  /** Cards, dialogs, inputs: white, or the dark theme's lifted grey. */
  raised: "light-dark(#ffffff, #121217)",
  /** The app's page ground (pre-join, loading, meeting backdrop). */
  canvas: "light-dark(#eeeef1, #08080b)",
  /**
   * The desk a whiteboard page lies on, and every band of meeting chrome that
   * touches it. One colour, so a room with a board open reads as two surfaces
   * (desk and paper) rather than the five near-identical greys it had grown.
   *
   * The board is paper on a desk, and the two must never be the same colour.
   * They were: the document, the tldraw canvas, and the page-lock mask that
   * hides off-page neighbours were all `#ffffff`, so on a phone the mask
   * painted white straight over the page's own drop shadow — a white sheet on
   * a white desk, edge invisible, nothing to tell you where you could draw.
   * Desktop escaped only because page-lock is off there and the shadow
   * survived, at 100% zoom; shadows scale with the camera, so at a phone's
   * fit-width zoom (~0.3) even an unmasked one is a couple of soft pixels.
   * The boundary is carried by colour contrast, which is zoom-invariant, and
   * the shadow is demoted to depth.
   *
   * `@orbmeet/whiteboard-client` publishes this token as `--wb-document-bg`
   * for the two consumers that cannot read a class — its static stylesheet and
   * the page-space page-lock mask. It used to keep its own copy of the hex;
   * that copy is gone.
   *
   * One value in both themes: the board is paper on a desk, and paper is
   * light whatever the room around it is.
   */
  board: "#e8e8ec",
  /** Transient notice shells: lighter than canvas so they read as raised. */
  elevated: "light-dark(#fcfcfd, #1b1b22)",
  /** A quiet inset well — code blocks, empty states, disabled fields. */
  sunken: "light-dark(#f4f4f7, #0d0d11)",
  /** Dark glass over a light ground (loading overlays on video). */
  inverse: "light-dark(#131218, #26262e)",
});

/** Text. Named by role, not by weight of grey. */
export const ink = stylex.defineVars({
  /** Headings and anything that has to be read first. */
  strong: "light-dark(#121216, #f2f1f7)",
  /** Body copy. */
  body: "light-dark(#45454f, #c4c2d0)",
  /**
   * Secondary copy, labels, metadata.
   *
   * Tuned against every ground it sits on, not just white: 5.9:1 on
   * `surface.raised`, 5.0 on `surface.canvas` and 5.4 on `surface.sunken` in
   * light; 6.6 on `surface.raised` and 7.3 on `surface.canvas` in dark.
   * Clearing 4.5 on all of them, with room to spare, is the property the token
   * has to hold — it is the default colour of every small label in the product.
   */
  muted: "light-dark(#64646f, #9a98a8)",
  /*
   * There is deliberately no `faint` here.
   *
   * It existed for "placeholder text and disabled labels — nothing else", at
   * slate-400 (2.56:1 on white), with a comment asking callers to use `muted`
   * for anything readable. Every one of its eleven call sites was readable
   * text: the speaker label in live captions, a playback error, "Last used"
   * dates, an upload percentage, a "revoked" key status. Placeholders never
   * used it at all — those point at `neutral.n400` directly.
   *
   * A token whose only observed use is the use its own doc forbids is a trap,
   * so it is gone rather than re-documented. Readable text is `muted`.
   */
  /** On a dark or saturated ground. */
  onDark: "#ffffff",
  /** On the accent fill. */
  onAccent: "#ffffff",
  /**
   * The colour a shadow is mixed from. The palette's own ink in light, so a
   * lift reads as this palette's shadow rather than a generic black blur; pure
   * black in dark, where a shadow mixed from light ink would glow instead.
   */
  shadow: "light-dark(#121216, #000000)",
});

/** Hairlines and dividers. */
export const border = stylex.defineVars({
  /** The default hairline on white. */
  subtle: "light-dark(#e2e2e8, #25252d)",
  /** A border meant to be seen — inputs, outlined buttons. */
  base: "light-dark(#d4d4dc, #2e2e38)",
  /** Hover / focus emphasis on an otherwise subtle edge. */
  strong: "light-dark(#b9b9c4, #42424e)",
  /** On a dark ground. */
  onDark: () => `color-mix(in oklab, ${ink.onDark} 14%, transparent)`,
});

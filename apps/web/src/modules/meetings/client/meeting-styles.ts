/**
 * Styles shared by the surfaces that float over a live Meeting.
 *
 * The room has one visual language for anything that interrupts it: a rounded
 * card, centred on the board, blurred over whatever is playing behind it, with
 * a glyph, two lines of copy and one action. Audio-blocked, screen-share
 * approval, access requests and the caption strip are all that same object.
 * They were four copies of it, and the copies had drifted — one was 3xl, one
 * was 2xl, and only two of them cleared the notch.
 */
import { accent, border, danger, ink, live, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { zIndex } from "@orbmeet/ui/tokens/layers.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { glass, scrim, scrimBase } from "@orbmeet/ui/tokens/wash.stylex";

export const banner = stylex.create({
  /**
   * The slot: centred horizontally, below the top chrome, and never wider than
   * the phone it is on.
   */
  slot: {
    position: "absolute",
    left: "50%",
    top: { default: space.s16, [bp.md]: space.s20 },
    transform: "translateX(-50%)",
    width: "min(92vw, 30rem)",
  },
  /** The same slot, but pinned to the viewport rather than to the stage. */
  slotFixed: { position: "fixed" },

  shell: {
    borderRadius: radii.panel,
    borderWidth: 1,
    borderStyle: "solid",
    padding: space.s3,
    boxShadow: shadows.banner,
  },
  row: { display: "flex", alignItems: "center", gap: space.s3 },
  rowTop: { alignItems: "flex-start" },

  glyph: {
    display: "flex",
    height: 40,
    width: 40,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.panel,
    borderWidth: 1,
    borderStyle: "solid",
  },
  body: { minWidth: 0, flexGrow: 1 },
  title: { fontSize: text.sm, lineHeight: leading.sm, fontWeight: weight.semibold },
  copy: { marginTop: space.s1, fontSize: text.xs, lineHeight: leading.sm },

  /** The banner's own button. Quiet by default — the copy is the message. */
  action: {
    flexShrink: 0,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${border.base} 80%, transparent)`,
    backgroundColor: { default: `${glass.panel}`, [env.hoverable]: { default: `${glass.panel}`, ":hover": surface.raised } },
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: neutral.n600,
  },
  /** …and loud, where pressing it is the whole point of the banner. */
  actionPrimary: {
    borderColor: "transparent",
    backgroundColor: { default: accent.a600, [env.hoverable]: { default: accent.a600, ":hover": accent.a500 } },
    color: ink.onAccent,
    fontWeight: weight.semibold,
  },
});

/**
 * The three tones a floating banner takes.
 *
 * Each one is a shell + glyph + title + copy set, applied together, so a
 * "denied" banner cannot end up with a neutral icon on a red card.
 */
export const bannerTone = stylex.create({
  neutralShell: {
    borderColor: `color-mix(in oklab, ${border.base} 80%, transparent)`,
    backgroundColor: `color-mix(in oklab, ${surface.elevated} 96%, transparent)`,
  },
  neutralGlyph: { backgroundColor: accent.a50, color: accent.a600, borderColor: accent.a100 },
  neutralTitle: { color: neutral.n800 },
  neutralCopy: { color: ink.muted },

  dangerShell: {
    borderColor: `color-mix(in oklab, ${danger.d200} 80%, transparent)`,
    backgroundColor: `color-mix(in oklab, ${danger.d50} 95%, transparent)`,
  },
  dangerGlyph: { backgroundColor: danger.d100, color: danger.d600, borderColor: `color-mix(in oklab, ${danger.d200} 80%, transparent)` },
  dangerTitle: { color: danger.d700 },
  dangerCopy: { color: danger.d600 },

  liveShell: {
    borderColor: `color-mix(in oklab, ${live.l200} 80%, transparent)`,
    backgroundColor: `color-mix(in oklab, ${live.l50} 95%, transparent)`,
  },
  liveGlyph: { backgroundColor: live.l100, color: live.l600, borderColor: `color-mix(in oklab, ${live.l200} 80%, transparent)` },
  liveTitle: { color: live.l700 },
  liveCopy: { color: live.l600 },
});

/** Z-layers a banner can occupy, named by what it must clear. */
export const bannerLayer = stylex.create({
  aboveCaptions: { zIndex: zIndex.meetingCaption },
  abovePip: { zIndex: zIndex.meetingPip },
});

/** The panels those buttons open. */
export const dockPopover = stylex.create({
  /** A full-width action inside a dock panel. */
  action: {
    width: "100%",
    borderWidth: 0,
    borderRadius: radii.control,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: ink.onDark,
    opacity: { default: 1, ":disabled": 0.5 },
  },
  /** A text field inside a dock panel. */
  field: {
    width: "100%",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n200, ":focus": accent.a400 },
    backgroundColor: neutral.n50,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontFamily: "inherit",
    fontSize: text.xs,
    color: neutral.n800,
    outlineStyle: "none",
    boxShadow: { default: "none", ":focus": `0 0 0 1px color-mix(in oklab, ${accent.a400} 30%, transparent)` },
    "::placeholder": { color: neutral.n500 },
  },
});


/**
 * The Meeting's side panels: chat, participants, hand raises.
 *
 * All three are the same object — a white column with a titled header, a
 * scrolling body and sometimes a footer — and each had its own copy of it. The header height in particular had drifted, so switching panels moved
 * the content under it by a couple of pixels.
 */
/**
 * The docked width of every side panel, whichever tab it shows. The meeting
 * shell reserves exactly this much board width for an open panel (through
 * `SIDE_PANEL_WIDTH`); a literal in two places would let the reservation and
 * the column disagree. One width for every tab means switching tabs never
 * re-fits the board beside the panel — Faces at 248px and the rest at 320px
 * moved the page between 1048 and 976px wide on every switch.
 */
const DESKTOP_PANEL_WIDTH_PX = 344;

/**
 * The docked panel's width, as CSS: 344px on a desktop window, down to 296px
 * on an iPad-sized one. It is wide enough to read a conversation in — at
 * 248px a two-line question wrapped to four. Beside content the faces sit at
 * the top of the same column, over the panel, so the page shares the width
 * with one column, not two. Sized from the window rather than the device class
 * because an iPad in landscape is classified as a desktop.
 */
export const SIDE_PANEL_WIDTH = `clamp(296px, 26vw, ${DESKTOP_PANEL_WIDTH_PX}px)`;

export const sidePanel = stylex.create({
  shell: {
    display: "flex",
    width: DESKTOP_PANEL_WIDTH_PX,
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: surface.raised,
    boxShadow: shadows.float,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: neutral.n100,
    backgroundColor: neutral.n50,
    paddingInline: space.s4,
    paddingBlock: space.s3_5,
  },
  close: {
    display: "flex",
    height: 32,
    width: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.field,
    borderWidth: 0,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n600 } },
  },

  body: { flexGrow: 1, overflowY: "auto", padding: space.s3 },
  /**
   * Inside the room's side column, which already is the surface: the panel
   * drops its own card — edge, corners, shadow, width — and fills the column.
   */
  docked: {
    width: "100%",
    height: "100%",
    borderWidth: 0,
    borderRadius: 0,
    boxShadow: "none",
  },
  /** A body whose rows sit on a faintly tinted ground, so cards read as cards. */
  bodyTinted: { backgroundColor: `color-mix(in oklab, ${neutral.n50} 30%, transparent)` },
});

/**
 * The unread-count badge: an accent pill with white digits that sits on a
 * control announcing what it is hiding.
 *
 * It appeared four times with four fill colours (a500 twice, a600 once) and
 * three type sizes; it is one decision, so it is one definition. `a600` is the
 * fill everywhere — it is the step `ink.onAccent` is tuned against.
 */
export const countBadge = stylex.create({
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    backgroundColor: accent.a600,
    paddingInline: space.s1,
    color: ink.onDark,
    fontWeight: weight.bold,
  },
  /** Pinned to the corner of a round phone-dock button. */
  corner: { position: "absolute", top: -2, right: -2, height: 16, minWidth: 16, fontSize: text.xs3 },
  /** On a top-bar control's icon, with a white cut-out ring so it reads over the glyph. */
  docked: {
    position: "absolute",
    top: -7,
    right: -9,
    height: 16,
    minWidth: 16,
    fontFamily: fonts.mono,
    fontSize: text.xs3,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: surface.raised,
  },
  /** Sitting inline at the end of a row rather than pinned to a corner. */
  inline: { height: 20, minWidth: 20, paddingInline: space.s1_5, fontSize: text.xs2 },
});

/**
 * The camera-switcher: a dark trigger on a video tile that opens a dark
 * popover listing the device's cameras.
 *
 * It was two whole copies — one on the gallery tile, a smaller one on the
 * mobile strip — that had drifted in trigger size, popover width, row padding
 * and blur. One definition, one component (`CameraSwitchButton` in
 * `video-layout/`); the desktop copy's sizing won because its rows are the
 * ones that have to stay legible mid-call.
 */
export const cameraMenu = stylex.create({
  trigger: {
    display: "flex",
    height: 28,
    width: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
    backgroundColor: { default: `${scrim.backdrop}`, [env.hoverable]: { default: `${scrim.backdrop}`, ":hover": `color-mix(in oklab, ${scrimBase.black} 70%, transparent)` } },
    color: { default: `color-mix(in oklab, ${ink.onDark} 90%, transparent)`, [env.hoverable]: { default: `color-mix(in oklab, ${ink.onDark} 90%, transparent)`, ":hover": ink.onDark } },
  },
  panel: {
    width: 224,
    borderRadius: radii.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: glass.veil,
    backgroundColor: `color-mix(in oklab, ${neutral.n950} 95%, transparent)`,
    padding: space.s3,
    boxShadow: `0 25px 50px -12px ${scrim.soft}`,
  },
  headingRow: {
    marginBottom: space.s2,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  heading: { margin: 0, fontSize: text.xs, fontWeight: weight.medium, color: `color-mix(in oklab, ${surface.raised} 70%, transparent)` },
  refresh: {
    display: "flex",
    height: 24,
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.field,
    color: { default: `color-mix(in oklab, ${ink.onDark} 40%, transparent)`, [env.hoverable]: { default: `color-mix(in oklab, ${ink.onDark} 40%, transparent)`, ":hover": `color-mix(in oklab, ${ink.onDark} 70%, transparent)` } },
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover": `${glass.veil}` },
    },
  },
  list: {
    maxHeight: 192,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  option: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s2,
    borderRadius: radii.control,
    paddingInline: space.s2_5,
    paddingBlock: space.s2,
    textAlign: "start",
    fontSize: text.sm,
    color: { default: `color-mix(in oklab, ${ink.onDark} 80%, transparent)`, [env.hoverable]: { default: `color-mix(in oklab, ${ink.onDark} 80%, transparent)`, ":hover": ink.onDark } },
    backgroundColor: {
      default: "transparent",
      [env.hoverable]: { default: "transparent", ":hover": `${glass.veil}` },
    },
  },
  /** The chosen camera: the one accent-tinted row in a dark list. */
  /**
   * Restates the hover step `option` declares. A property's conditional
   * variants merge as one unit in StyleX, so a flat value here would take the
   * base and the hover with it and leave the selected camera inert.
   */
  optionSelected: {
    backgroundColor: {
      default: `color-mix(in oklab, ${accent.a500} 20%, transparent)`,
      [env.hoverable]: {
        default: `color-mix(in oklab, ${accent.a500} 20%, transparent)`,
        ":hover": `color-mix(in oklab, ${accent.a500} 30%, transparent)`,
      },
    },
    color: accent.a300,
  },
  optionGlyph: {
    display: "flex",
    height: 20,
    width: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.field,
    backgroundColor: glass.veil,
  },
  optionGlyphSelected: { backgroundColor: `color-mix(in oklab, ${accent.a500} 30%, transparent)` },
  optionLabel: { flexGrow: 1, minWidth: 0, fontSize: text.xs },
});

/**
 * A participant's video frame, as painted inside a tile.
 *
 * Three components draw the same video element — the gallery tile, the mobile
 * strip, the floating pip — and each carried its own copy of "fill the box,
 * crop to cover, mirror the local camera". One definition so a change of crop
 * policy is one change.
 *
 * Applied by spreading `stylex.props(...)` onto `MeetingVideoTrack`, which
 * forwards them to the underlying `<video>`; LiveKit's component takes plain
 * DOM props, not `sx`.
 */
export const videoTrack = stylex.create({
  fill: { height: "100%", width: "100%", objectFit: "cover" },
  /** The local camera only: everyone else is already the right way round. */
  mirrored: { transform: "scaleX(-1)" },
});

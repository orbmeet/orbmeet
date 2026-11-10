import { BrandMark } from "@orbmeet/ui/react";
import { accent, border, danger, identity, ink, live, neutral, surface, violet, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { FileText, Lock, MousePointer2, Pencil, Search, Shapes, Type } from "lucide-react";
import type { ReactNode } from "react";

/**
 * What a visitor would otherwise only learn by joining a call: the room, how
 * people get in, the board, Orb, what is left afterwards, and the rooms you
 * come back to. Every picture here is drawn in markup rather than shipped as
 * a screenshot, so it stays sharp, costs no request, and can't go stale
 * against a photo of an older build.
 */

/** The sample board's handwriting. Loaded only by this page (theme.css). */
const HAND = '"Caveat", "Bradley Hand", "Segoe Print", cursive';

const ALSO = [
  { title: "Screen sharing", body: "Present a tab, a window or your whole screen." },
  { title: "Live captions", body: "See what’s said as it’s said." },
  { title: "Recording", body: "Keep the call to watch back later." },
  { title: "Go live", body: "Stream to YouTube or Twitch." },
  { title: "Shared timer", body: "Everyone sees the same countdown." },
  { title: "Raise hand", body: "Take turns without talking over." },
  { title: "Private messages", body: "A quiet word to one person." },
  { title: "Keyboard first", body: "⌘K runs any control." },
] as const;

const PACKING = ["Train tickets", "Walking shoes", "Swimsuit, if it’s sunny", "Charger and adapter", "A light jacket"] as const;

// ─── Orb demo timeline ───────────────────────────────────────────────────────
// One 16s loop. Sam asks Orb, in front of everyone, for a packing list and it
// writes itself onto the board; then the chat slides to the private tab where
// Maya, just arrived, asks what she missed and only she sees the answer.
// Every element runs the whole loop with its own keyframes, so the beats stay
// in step without JavaScript.

const kAsk = stylex.keyframes({
  "0%, 2%": { opacity: 0, transform: "translateY(6px)" },
  "6%, 92%": { opacity: 1, transform: "none" },
  "97%, 100%": { opacity: 0, transform: "none" },
});
const kTitle = stylex.keyframes({
  "0%, 12%": { opacity: 0, transform: "translateY(4px)" },
  "15%, 92%": { opacity: 1, transform: "none" },
  "97%, 100%": { opacity: 0, transform: "none" },
});
const kItem0 = stylex.keyframes({
  "0%, 16%": { opacity: 0, transform: "translateX(-6px)" },
  "19%, 92%": { opacity: 1, transform: "none" },
  "97%, 100%": { opacity: 0, transform: "none" },
});
const kItem1 = stylex.keyframes({
  "0%, 20%": { opacity: 0, transform: "translateX(-6px)" },
  "23%, 92%": { opacity: 1, transform: "none" },
  "97%, 100%": { opacity: 0, transform: "none" },
});
const kItem2 = stylex.keyframes({
  "0%, 24%": { opacity: 0, transform: "translateX(-6px)" },
  "27%, 92%": { opacity: 1, transform: "none" },
  "97%, 100%": { opacity: 0, transform: "none" },
});
const kItem3 = stylex.keyframes({
  "0%, 28%": { opacity: 0, transform: "translateX(-6px)" },
  "31%, 92%": { opacity: 1, transform: "none" },
  "97%, 100%": { opacity: 0, transform: "none" },
});
const kItem4 = stylex.keyframes({
  "0%, 32%": { opacity: 0, transform: "translateX(-6px)" },
  "35%, 92%": { opacity: 1, transform: "none" },
  "97%, 100%": { opacity: 0, transform: "none" },
});
const kReply = stylex.keyframes({
  "0%, 36%": { opacity: 0, transform: "translateY(6px)" },
  "40%, 92%": { opacity: 1, transform: "none" },
  "97%, 100%": { opacity: 0, transform: "none" },
});
const kPrivateAsk = stylex.keyframes({
  "0%, 58%": { opacity: 0, transform: "translateY(6px)" },
  "62%, 92%": { opacity: 1, transform: "none" },
  "97%, 100%": { opacity: 0, transform: "none" },
});
const kPrivateAnswer = stylex.keyframes({
  "0%, 71%": { opacity: 0, transform: "translateY(6px)" },
  "75%, 92%": { opacity: 1, transform: "none" },
  "97%, 100%": { opacity: 0, transform: "none" },
});
const kShare = stylex.keyframes({
  "0%, 74%": { opacity: 0, transform: "none" },
  "78%, 92%": { opacity: 1, transform: "none" },
  "97%, 100%": { opacity: 0, transform: "none" },
});
const kChip = stylex.keyframes({
  "0%, 8%": { opacity: 0 },
  "11%, 34%": { opacity: 1 },
  "37%, 100%": { opacity: 0 },
});
const kDots = stylex.keyframes({
  "0%, 63%": { opacity: 0 },
  "65%, 70%": { opacity: 1 },
  "72%, 100%": { opacity: 0 },
});
const kEveryone = stylex.keyframes({
  "0%, 50%": { opacity: 1 },
  "54%, 100%": { opacity: 0 },
});
const kEveryoneTab = stylex.keyframes({
  "0%, 50%": { opacity: 1 },
  "54%, 96%": { opacity: 0 },
  "100%": { opacity: 1 },
});
const kPrivate = stylex.keyframes({
  "0%, 52%": { opacity: 0 },
  "56%, 92%": { opacity: 1 },
  "97%, 100%": { opacity: 0 },
});

const loop = stylex.create({
  base: {
    animationDuration: "16s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease",
  },
  ask: { animationName: { default: kAsk, [env.reducedMotion]: "none" } },
  title: { animationName: { default: kTitle, [env.reducedMotion]: "none" } },
  item0: { animationName: { default: kItem0, [env.reducedMotion]: "none" } },
  item1: { animationName: { default: kItem1, [env.reducedMotion]: "none" } },
  item2: { animationName: { default: kItem2, [env.reducedMotion]: "none" } },
  item3: { animationName: { default: kItem3, [env.reducedMotion]: "none" } },
  item4: { animationName: { default: kItem4, [env.reducedMotion]: "none" } },
  reply: { animationName: { default: kReply, [env.reducedMotion]: "none" } },
  privateAsk: { animationName: { default: kPrivateAsk, [env.reducedMotion]: "none" } },
  privateAnswer: { animationName: { default: kPrivateAnswer, [env.reducedMotion]: "none" } },
  share: { animationName: { default: kShare, [env.reducedMotion]: "none" } },
  private: { animationName: { default: kPrivate, [env.reducedMotion]: "none" } },
  // Without motion the demo holds on its last frame: the list on the board and
  // the private answer. The moments in between are hidden rather than stacked.
  chip: { animationName: { default: kChip, [env.reducedMotion]: "none" }, opacity: { default: 1, [env.reducedMotion]: 0 } },
  dots: { animationName: { default: kDots, [env.reducedMotion]: "none" }, opacity: { default: 1, [env.reducedMotion]: 0 } },
  everyone: { animationName: { default: kEveryone, [env.reducedMotion]: "none" }, opacity: { default: 1, [env.reducedMotion]: 0 } },
  everyoneTab: { animationName: { default: kEveryoneTab, [env.reducedMotion]: "none" }, opacity: { default: 1, [env.reducedMotion]: 0 } },
});

const itemLoops = [loop.item0, loop.item1, loop.item2, loop.item3, loop.item4];

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = stylex.create({
  wrap: {
    width: "100%",
    maxWidth: "70rem",
    marginInline: "auto",
    paddingInline: space.s6,
    boxSizing: "border-box",
  },
  wideWrap: { maxWidth: "74rem" },

  // The room
  shot: { paddingTop: space.s14 },
  frame: {
    padding: space.s2_5,
    borderRadius: 18,
    backgroundColor: surface.canvas,
    boxShadow: shadows.elevated,
  },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    paddingBlock: space.s2,
    paddingInline: space.s3,
    borderRadius: 12,
    backgroundColor: surface.raised,
    fontSize: text.control,
  },
  barTitle: { display: "flex", flexDirection: "column", lineHeight: 1.2, marginInlineEnd: "auto", fontWeight: weight.medium },
  barClock: { fontSize: "0.6875rem", fontWeight: weight.normal, color: live.l700 },
  segments: { display: { default: "none", [bp.sm]: "inline-flex" }, padding: 3, borderRadius: 10, backgroundColor: surface.sunken },
  segment: { paddingBlock: 5, paddingInline: space.s2_5, borderRadius: 8, color: ink.muted },
  segmentOn: { backgroundColor: surface.raised, color: ink.strong, fontWeight: weight.medium, boxShadow: shadows.hairline },
  dock: { display: { default: "none", [bp.lg]: "flex" }, gap: space.s1_5 },
  dockItem: { paddingBlock: 6, paddingInline: space.s2_5, borderRadius: 8, backgroundColor: surface.sunken },
  dockQuiet: { backgroundColor: "transparent", color: ink.muted },
  leave: { paddingBlock: 6, paddingInline: space.s3, borderRadius: 8, backgroundColor: danger.d600, color: ink.onAccent, fontWeight: weight.medium },
  room: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.lg]: "minmax(0, 1fr) 16rem" },
    gap: space.s2_5,
    marginTop: space.s2_5,
  },
  desk: { display: "flex", flexDirection: "column", gap: space.s3, padding: space.s3_5, borderRadius: 12, backgroundColor: surface.board },
  deskBar: { display: "flex", flexWrap: "wrap", gap: space.s2, fontSize: text.xs },
  deskChip: { paddingBlock: 6, paddingInline: space.s2_5, borderRadius: 8, backgroundColor: surface.raised },
  presenting: { backgroundColor: accent.a50, color: accent.a700, fontWeight: weight.medium },
  paper: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: space.s5,
    paddingBlock: { default: space.s6, [bp.md]: space.s8 },
    paddingInline: { default: space.s5, [bp.md]: space.s10 },
    borderRadius: 4,
    backgroundColor: surface.raised,
    color: ink.strong,
    fontFamily: HAND,
    fontWeight: 500,
  },
  boardTitleRow: { display: "flex", alignItems: "baseline", flexWrap: "wrap", columnGap: space.s4 },
  boardTitle: { position: "relative", fontSize: { default: "2.25rem", [bp.md]: "2.75rem" }, lineHeight: 1 },
  underline: { position: "absolute", insetInline: 0, bottom: -8, width: "100%", height: 10, color: accent.a600 },
  boardDate: { fontSize: "1.75rem", color: neutral.n500 },
  days: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.sm]: "repeat(3, minmax(0, 1fr))" },
    gap: { default: space.s3, [bp.sm]: space.s7 },
    fontSize: "1.5625rem",
    lineHeight: 1.25,
  },
  day: { display: "flex", flexDirection: "column", gap: space.s1 },
  dayName: { fontSize: "1.875rem", color: accent.a600 },
  circled: { position: "relative", alignSelf: "flex-start" },
  circle: { position: "absolute", left: "-6%", top: "-25%", width: "112%", height: "150%", overflow: "visible", color: warning.w600 },
  notes: { display: "flex", flexWrap: "wrap", gap: space.s4, marginTop: space.s1 },
  note: {
    paddingBlock: space.s3,
    paddingInline: space.s4,
    fontSize: "1.4375rem",
    lineHeight: 1.15,
    boxShadow: shadows.chip,
  },
  noteYellow: { backgroundColor: identity.surface2, transform: "rotate(-1.5deg)" },
  noteViolet: { backgroundColor: violet.v100, transform: "rotate(1deg)" },
  cursor: {
    position: "absolute",
    right: { default: space.s6, [bp.md]: space.s16 },
    bottom: { default: space.s6, [bp.md]: space.s14 },
    display: "inline-flex",
    alignItems: "flex-start",
    gap: 2,
    fontFamily: fonts.sans,
  },
  pointer: { color: live.l600 },
  cursorTag: {
    marginTop: space.s3,
    paddingBlock: 2,
    paddingInline: 7,
    borderRadius: 6,
    backgroundColor: live.l600,
    color: ink.onAccent,
    fontSize: "0.6875rem",
    fontWeight: weight.medium,
  },
  side: { display: { default: "none", [bp.lg]: "flex" }, flexDirection: "column", gap: space.s2_5 },
  tiles: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: space.s2 },
  tile: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    aspectRatio: "1 / 1",
    borderRadius: 10,
    backgroundColor: surface.raised,
  },
  tileSpeaking: { boxShadow: `inset 0 0 0 2px ${accent.a600}` },
  avatar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 40,
    height: 40,
    borderRadius: "50%",
    fontSize: text.sm,
    fontWeight: weight.semibold,
  },
  avatarWarm: { backgroundColor: identity.surface7, color: identity.ink7 },
  avatarGreen: { backgroundColor: identity.surface5, color: identity.ink5 },
  tileName: { position: "absolute", left: space.s2, bottom: 6, fontSize: "0.6875rem" },
  chat: {
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    gap: space.s2_5,
    padding: space.s3_5,
    borderRadius: 12,
    backgroundColor: surface.raised,
    fontSize: "0.78125rem",
    lineHeight: 1.45,
  },
  chatTitle: { fontSize: text.control, fontWeight: weight.semibold },
  chatName: { display: "block", fontWeight: weight.semibold },
  chatBody: { color: neutral.n700 },
  composer: {
    display: "flex",
    alignItems: "center",
    height: 34,
    marginTop: "auto",
    paddingInline: space.s2_5,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.subtle,
    color: ink.muted,
  },

  // Feature rows
  feature: { paddingTop: { default: space.s24, [bp.lg]: space.s32 } },
  split: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.lg]: "minmax(0, 5fr) minmax(0, 6fr)" },
    alignItems: "center",
    gap: { default: space.s8, [bp.lg]: space.s16 },
  },
  h2: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: "clamp(1.875rem, 3.4vw, 2.625rem)",
    fontWeight: weight.semibold,
    lineHeight: 1.1,
    letterSpacing: "-0.035em",
    textWrap: "balance",
  },
  lede: { margin: 0, marginTop: space.s4, fontSize: text.lg, lineHeight: 1.6, color: ink.body, textWrap: "pretty" },
  intro: { maxWidth: "40rem" },
  well: { padding: { default: space.s5, [bp.md]: space.s7 }, borderRadius: 16, backgroundColor: neutral.n50 },
  card: { borderRadius: 12, backgroundColor: surface.raised },

  // Join card
  joinWell: { display: "flex", justifyContent: "center", paddingBlock: space.s10 },
  joinCard: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3_5,
    width: "100%",
    maxWidth: "21rem",
    padding: space.s6,
    boxSizing: "border-box",
    borderRadius: 14,
    backgroundColor: surface.raised,
    boxShadow: shadows.card,
  },
  cardTitle: { fontSize: text.base, fontWeight: weight.semibold },
  liveMeta: { fontSize: text.control, color: live.l700 },
  fieldLabel: { fontSize: text.control, color: ink.body },
  fakeField: {
    display: "flex",
    alignItems: "center",
    height: 42,
    marginTop: space.s1_5,
    paddingInline: space.s3,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: accent.a600,
    fontSize: "0.9375rem",
  },
  fakeButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    borderRadius: 10,
    backgroundColor: accent.a600,
    color: ink.onAccent,
    fontSize: "0.9375rem",
    fontWeight: weight.medium,
  },

  // Board tools
  boardWell: { display: "flex", alignItems: "stretch", gap: space.s4 },
  tools: { display: "flex", flexDirection: "column", gap: space.s1_5, padding: space.s2, borderRadius: 12, backgroundColor: surface.raised },
  tool: { display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 9, color: neutral.n700 },
  toolOn: { backgroundColor: accent.a600, color: ink.onAccent },
  boardSide: { flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: space.s3 },
  pills: { display: "flex", flexWrap: "wrap", gap: space.s2, fontSize: text.control },
  pill: { paddingBlock: 7, paddingInline: space.s3, borderRadius: 9, backgroundColor: surface.raised, color: ink.body },
  pillOn: { backgroundColor: accent.a600, color: ink.onAccent, fontWeight: weight.medium },
  sketch: { flexGrow: 1, minHeight: 180, borderRadius: 8, backgroundColor: surface.raised },
  sketchSvg: { display: "block", width: "100%", height: "100%", minHeight: 180 },

  // Orb demo
  stage: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.md]: "repeat(2, minmax(0, 1fr))" },
    gap: space.s3,
    marginTop: space.s12,
    padding: space.s3,
    borderRadius: 20,
    backgroundColor: neutral.n100,
  },
  stageBoard: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2_5,
    minHeight: { default: 0, [bp.md]: 340 },
    paddingBlock: { default: space.s6, [bp.md]: space.s7 },
    paddingInline: { default: space.s6, [bp.md]: space.s8 },
    boxSizing: "border-box",
    borderRadius: 12,
    backgroundColor: surface.raised,
    color: ink.strong,
    fontSize: text.base,
  },
  listTitle: { marginBottom: space.s1_5, fontSize: text.xl, fontWeight: weight.semibold, letterSpacing: "-0.01em" },
  listItem: { display: "flex", alignItems: "center", gap: space.s2_5 },
  checkbox: { width: 16, height: 16, flexShrink: 0, borderRadius: 4, borderWidth: 1.5, borderStyle: "solid", borderColor: neutral.n300 },
  drawingChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s2,
    alignSelf: "flex-start",
    marginTop: "auto",
    paddingBlock: 6,
    paddingInline: space.s3,
    borderRadius: 999,
    backgroundColor: accent.a50,
    color: accent.a700,
    fontSize: text.control,
    fontWeight: weight.medium,
  },
  stageChat: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3_5,
    minHeight: { default: 0, [bp.md]: 340 },
    padding: space.s4,
    boxSizing: "border-box",
    borderRadius: 12,
    backgroundColor: surface.raised,
  },
  tabs: { display: "inline-flex", alignSelf: "flex-start", padding: 3, borderRadius: 10, backgroundColor: surface.sunken, fontSize: text.control },
  tab: { position: "relative", display: "inline-flex", alignItems: "center", gap: space.s1_5, paddingBlock: 6, paddingInline: space.s3_5 },
  tabFill: { position: "absolute", inset: 0, borderRadius: 8, backgroundColor: surface.raised, boxShadow: shadows.hairline },
  tabLabel: { position: "relative", display: "inline-flex", alignItems: "center", gap: space.s1_5 },
  feed: { position: "relative", flexGrow: 1, minHeight: 220 },
  pane: { position: "absolute", inset: 0, display: "flex", flexDirection: "column", gap: space.s3, fontSize: text.sm, lineHeight: 1.5 },
  mine: { alignSelf: "flex-end", maxWidth: "85%", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: space.s1 },
  who: { fontSize: text.xs, color: ink.muted },
  bubbleOut: { paddingBlock: 9, paddingInline: 13, borderRadius: 14, borderEndEndRadius: 4, backgroundColor: accent.a600, color: ink.onAccent },
  bubbleDark: { backgroundColor: neutral.n800 },
  mention: { fontWeight: weight.semibold, color: violet.v100 },
  orbRow: { display: "flex", alignItems: "flex-start", gap: space.s2_5 },
  orbBody: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: space.s1_5 },
  orbName: { fontSize: text.xs, fontWeight: weight.semibold, color: violet.v700 },
  orbNote: { fontWeight: weight.normal, color: ink.muted },
  bubbleIn: { paddingBlock: 9, paddingInline: 13, borderRadius: 14, borderStartStartRadius: 4, backgroundColor: violet.v50, color: ink.strong },
  inlineAction: { fontSize: text.xs, fontWeight: weight.medium, color: accent.a700 },
  dots: { display: "inline-flex", gap: space.s1, paddingInlineStart: space.s8 },
  dot: { width: 6, height: 6, borderRadius: "50%", backgroundColor: violet.v400 },
  stageComposer: {
    display: "flex",
    alignItems: "center",
    height: 40,
    paddingInline: space.s3,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.subtle,
    color: ink.muted,
    fontSize: text.sm,
  },

  // After the call
  recap: { display: "flex", flexDirection: "column", gap: space.s3_5, paddingBlock: space.s4, paddingInline: space.s5 },
  recapTitle: { fontSize: "1.0625rem", fontWeight: weight.semibold },
  recapMeta: { fontSize: text.control, color: ink.muted },
  recapTabs: { display: "flex", flexWrap: "wrap", gap: space.s1_5, fontSize: text.control },
  recapTab: { paddingBlock: 6, paddingInline: 11, borderRadius: 8, color: ink.body },
  recapTabOn: { backgroundColor: accent.a50, color: accent.a700, fontWeight: weight.medium },
  recapBody: { display: "flex", flexDirection: "column", gap: space.s2, fontSize: text.sm, lineHeight: 1.5, color: neutral.n700 },
  strong: { fontWeight: weight.semibold, color: ink.strong },
  search: { display: "flex", alignItems: "center", gap: space.s2, height: 44, marginTop: space.s3, paddingInline: space.s3_5, color: ink.muted, fontSize: text.sm },

  // Rooms
  linkCard: { display: "flex", alignItems: "center", gap: space.s3, paddingBlock: space.s4, paddingInline: space.s4 },
  linkText: { display: "flex", flexDirection: "column", gap: 2, marginInlineEnd: "auto", minWidth: 0 },
  small: { fontSize: text.control, color: ink.muted },
  linkCode: { fontFamily: fonts.mono, fontSize: "0.9375rem" },
  accentText: { color: accent.a600 },
  copyChip: { display: "inline-flex", alignItems: "center", height: 34, paddingInline: space.s3, borderRadius: 8, backgroundColor: surface.sunken, fontSize: text.control, fontWeight: weight.medium },
  spaceCard: { display: "flex", flexDirection: "column", gap: space.s3, marginTop: space.s2_5, paddingBlock: space.s4, paddingInline: space.s4 },
  spaceHead: { display: "flex", alignItems: "center", gap: space.s3 },
  spaceInitial: { display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: 9, backgroundColor: violet.v100, color: accent.a700, fontWeight: weight.semibold },
  spaceName: { display: "flex", flexDirection: "column", fontSize: "0.9375rem", fontWeight: weight.medium },
  history: { display: "flex", flexDirection: "column", fontSize: text.sm },
  historyRow: { display: "flex", justifyContent: "space-between", paddingBlock: 9, borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: border.subtle },

  // Also
  alsoTitle: { margin: 0, fontSize: text.xl, fontWeight: weight.semibold, letterSpacing: "-0.015em" },
  alsoList: {
    display: "grid",
    gridTemplateColumns: { default: "repeat(2, minmax(0, 1fr))", [bp.lg]: "repeat(4, minmax(0, 1fr))" },
    rowGap: space.s6,
    columnGap: space.s8,
    margin: 0,
    marginTop: space.s6,
    padding: 0,
    listStyle: "none",
    fontSize: "0.9375rem",
    color: ink.body,
  },
  alsoItem: { display: "flex", flexDirection: "column", gap: space.s1 },
  alsoName: { color: ink.strong, fontWeight: weight.medium },
});

// ─── Pieces ──────────────────────────────────────────────────────────────────

function Feature({ id, title, children, picture }: { id: string; title: string; children: ReactNode; picture: ReactNode }) {
  return (
    <section aria-labelledby={id} {...stylex.props(styles.wrap, styles.feature)}>
      <div {...stylex.props(styles.split)}>
        <div>
          <h2 id={id} {...stylex.props(styles.h2)}>{title}</h2>
          <p {...stylex.props(styles.lede)}>{children}</p>
        </div>
        {picture}
      </div>
    </section>
  );
}

/** A call in progress: three friends planning a weekend on the board. */
function SampleRoom() {
  return (
    <div aria-hidden="true" {...stylex.props(styles.frame)}>
      <div {...stylex.props(styles.bar)}>
        <BrandMark size={22} />
        <span {...stylex.props(styles.barTitle)}>
          Weekend away
          <span {...stylex.props(styles.barClock)}>● 12:40</span>
        </span>
        <span {...stylex.props(styles.segments)}>
          <span {...stylex.props(styles.segment)}>Talk</span>
          <span {...stylex.props(styles.segment, styles.segmentOn)}>Board</span>
          <span {...stylex.props(styles.segment)}>Screen</span>
        </span>
        <span {...stylex.props(styles.dock)}>
          <span {...stylex.props(styles.dockItem)}>Mute</span>
          <span {...stylex.props(styles.dockItem)}>Video</span>
          <span {...stylex.props(styles.dockItem, styles.dockQuiet)}>Chat</span>
          <span {...stylex.props(styles.dockItem, styles.dockQuiet)}>People 3</span>
        </span>
        <span {...stylex.props(styles.leave)}>Leave</span>
      </div>
      <div {...stylex.props(styles.room)}>
        <div {...stylex.props(styles.desk)}>
          <div {...stylex.props(styles.deskBar)}>
            <span {...stylex.props(styles.deskChip)}>Page 1 of 2</span>
            <span {...stylex.props(styles.deskChip, styles.presenting)}>● You’re presenting</span>
          </div>
          <div {...stylex.props(styles.paper)}>
            <div {...stylex.props(styles.boardTitleRow)}>
              <span {...stylex.props(styles.boardTitle)}>
                Weekend away
                <svg viewBox="0 0 200 10" preserveAspectRatio="none" {...stylex.props(styles.underline)}>
                  <path d="M2 6 C 50 2, 120 9, 198 4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
              </span>
              <span {...stylex.props(styles.boardDate)}>June 12–14</span>
            </div>
            <div {...stylex.props(styles.days)}>
              <div {...stylex.props(styles.day)}>
                <span {...stylex.props(styles.dayName)}>Fri</span>
                <span>train at 6</span>
                <span>check in, dinner</span>
              </div>
              <div {...stylex.props(styles.day)}>
                <span {...stylex.props(styles.dayName)}>Sat</span>
                <span>old town walk</span>
                <span {...stylex.props(styles.circled)}>
                  castle at sunset
                  <svg viewBox="0 0 120 40" preserveAspectRatio="none" {...stylex.props(styles.circle)}>
                    <ellipse cx="60" cy="20" rx="57" ry="17" fill="none" stroke="currentColor" strokeWidth="2" />
                  </svg>
                </span>
                <span>market lunch</span>
              </div>
              <div {...stylex.props(styles.day)}>
                <span {...stylex.props(styles.dayName)}>Sun</span>
                <span>beach, if sunny</span>
                <span>train home 6 pm</span>
              </div>
            </div>
            <div {...stylex.props(styles.notes)}>
              <span {...stylex.props(styles.note, styles.noteYellow)}>Budget: ~€400 each?</span>
              <span {...stylex.props(styles.note, styles.noteViolet)}>Sam books the hotel</span>
            </div>
            <span {...stylex.props(styles.cursor)}>
              <MousePointer2 size={16} fill="currentColor" stroke="white" strokeWidth={1.5} {...stylex.props(styles.pointer)} />
              <span {...stylex.props(styles.cursorTag)}>Maya</span>
            </span>
          </div>
        </div>
        <div {...stylex.props(styles.side)}>
          <div {...stylex.props(styles.tiles)}>
            <div {...stylex.props(styles.tile, styles.tileSpeaking)}>
              <span {...stylex.props(styles.avatar, styles.avatarWarm)}>SR</span>
              <span {...stylex.props(styles.tileName)}>Sam</span>
            </div>
            <div {...stylex.props(styles.tile)}>
              <span {...stylex.props(styles.avatar, styles.avatarGreen)}>M</span>
              <span {...stylex.props(styles.tileName)}>Maya · guest</span>
            </div>
          </div>
          <div {...stylex.props(styles.chat)}>
            <span {...stylex.props(styles.chatTitle)}>Chat</span>
            <span><span {...stylex.props(styles.chatName)}>Maya</span><span {...stylex.props(styles.chatBody)}>I can sort the train tickets.</span></span>
            <span><span {...stylex.props(styles.chatName)}>Sam</span><span {...stylex.props(styles.chatBody)}>Then I’ll get the hotel.</span></span>
            <span><span {...stylex.props(styles.chatName)}>Maya</span><span {...stylex.props(styles.chatBody)}>Circled the castle, can’t miss it.</span></span>
            <span {...stylex.props(styles.composer)}>Message everyone</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function GuestJoinCard() {
  return (
    <div aria-hidden="true" {...stylex.props(styles.well, styles.joinWell)}>
      <div {...stylex.props(styles.joinCard)}>
        <div>
          <div {...stylex.props(styles.cardTitle)}>Sam’s meeting</div>
          <div {...stylex.props(styles.liveMeta)}>● In progress · 2 people</div>
        </div>
        <div>
          <div {...stylex.props(styles.fieldLabel)}>Your name</div>
          <div {...stylex.props(styles.fakeField)}>Maya</div>
        </div>
        <div {...stylex.props(styles.fakeButton)}>Join meeting</div>
      </div>
    </div>
  );
}

function BoardTools() {
  return (
    <div aria-hidden="true" {...stylex.props(styles.well, styles.boardWell)}>
      <div {...stylex.props(styles.tools)}>
        <span {...stylex.props(styles.tool)}><MousePointer2 size={18} strokeWidth={1.8} /></span>
        <span {...stylex.props(styles.tool, styles.toolOn)}><Pencil size={18} strokeWidth={1.8} /></span>
        <span {...stylex.props(styles.tool)}><Type size={18} strokeWidth={1.8} /></span>
        <span {...stylex.props(styles.tool)}><Shapes size={18} strokeWidth={1.8} /></span>
        <span {...stylex.props(styles.tool)}><FileText size={18} strokeWidth={1.8} /></span>
      </div>
      <div {...stylex.props(styles.boardSide)}>
        <div {...stylex.props(styles.pills)}>
          <span {...stylex.props(styles.pill)}>Following Sam</span>
          <span {...stylex.props(styles.pill, styles.pillOn)}>Ask to edit</span>
        </div>
        <div {...stylex.props(styles.sketch)}>
          <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid meet" {...stylex.props(styles.sketchSvg)}>
            <rect x="28" y="44" width="76" height="40" rx="8" fill="none" stroke="#2b2838" strokeWidth="1.8" />
            <rect x="140" y="44" width="76" height="40" rx="8" fill="#ece8ff" stroke="#5838ee" strokeWidth="1.8" />
            <path d="M106 64h28 m-6 -5 l6 5 l-6 5" fill="none" stroke="#2b2838" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M226 118 C 244 96, 262 140, 292 106" fill="none" stroke="#16a34a" strokeWidth="3" strokeLinecap="round" />
            <rect x="28" y="112" width="140" height="36" rx="3" fill="#fdf3c4" />
          </svg>
        </div>
      </div>
    </div>
  );
}

/** Orb in front of everyone, then Orb in private. Loops; holds still for reduced motion. */
function OrbDemo() {
  return (
    <div
      role="img"
      aria-label="Sam asks Orb for a packing list and it appears on the board for everyone. Then Maya, who just joined, privately asks Orb what she missed, and only she sees the answer."
      {...stylex.props(styles.stage)}
    >
      <div aria-hidden="true" {...stylex.props(styles.stageBoard)}>
        <span {...stylex.props(styles.listTitle, loop.base, loop.title)}>Packing list</span>
        {PACKING.map((item, index) => (
          <span key={item} {...stylex.props(styles.listItem, loop.base, itemLoops[index])}>
            <span {...stylex.props(styles.checkbox)} />
            {item}
          </span>
        ))}
        <span {...stylex.props(styles.drawingChip, loop.base, loop.chip)}>
          <BrandMark size={14} />
          Orb is drawing for everyone…
        </span>
      </div>

      <div aria-hidden="true" {...stylex.props(styles.stageChat)}>
        <div {...stylex.props(styles.tabs)}>
          <span {...stylex.props(styles.tab)}>
            <span {...stylex.props(styles.tabFill, loop.base, loop.everyoneTab)} />
            <span {...stylex.props(styles.tabLabel)}>Everyone</span>
          </span>
          <span {...stylex.props(styles.tab)}>
            <span {...stylex.props(styles.tabFill, loop.base, loop.private)} />
            <span {...stylex.props(styles.tabLabel)}>
              <Lock size={12} strokeWidth={2.2} />
              Just me and Orb
            </span>
          </span>
        </div>

        <div {...stylex.props(styles.feed)}>
          <div {...stylex.props(styles.pane, loop.base, loop.everyone)}>
            <div {...stylex.props(styles.mine, loop.base, loop.ask)}>
              <span {...stylex.props(styles.who)}>Sam</span>
              <span {...stylex.props(styles.bubbleOut)}>
                <span {...stylex.props(styles.mention)}>@Orb</span> add a packing list for the weekend
              </span>
            </div>
            <div {...stylex.props(styles.orbRow, loop.base, loop.reply)}>
              <BrandMark size={22} />
              <div {...stylex.props(styles.orbBody)}>
                <span {...stylex.props(styles.orbName)}>Orb</span>
                <span {...stylex.props(styles.bubbleIn)}>Added a packing list to the board.</span>
                <span {...stylex.props(styles.inlineAction)}>Undo</span>
              </div>
            </div>
          </div>

          <div {...stylex.props(styles.pane, loop.base, loop.private)}>
            <div {...stylex.props(styles.mine, loop.base, loop.privateAsk)}>
              <span {...stylex.props(styles.who)}>Maya, just joined</span>
              <span {...stylex.props(styles.bubbleOut, styles.bubbleDark)}>What did I miss?</span>
            </div>
            <span {...stylex.props(styles.dots, loop.base, loop.dots)}>
              <span {...stylex.props(styles.dot)} />
              <span {...stylex.props(styles.dot)} />
              <span {...stylex.props(styles.dot)} />
            </span>
            <div {...stylex.props(styles.orbRow, loop.base, loop.privateAnswer)}>
              <BrandMark size={22} />
              <div {...stylex.props(styles.orbBody)}>
                <span {...stylex.props(styles.orbName)}>
                  Orb<span {...stylex.props(styles.orbNote)}> · only you see this</span>
                </span>
                <span {...stylex.props(styles.bubbleIn)}>
                  They picked June 12–14. Sam is booking the hotel, and you offered to get the train tickets.
                </span>
                <span {...stylex.props(styles.inlineAction, loop.base, loop.share)}>Share with everyone</span>
              </div>
            </div>
          </div>
        </div>

        <span {...stylex.props(styles.stageComposer)}>Message, or type @Orb</span>
      </div>
    </div>
  );
}

function RecapCard() {
  return (
    <div aria-hidden="true" {...stylex.props(styles.well)}>
      <div {...stylex.props(styles.card, styles.recap)}>
        <div>
          <div {...stylex.props(styles.recapTitle)}>Weekend away</div>
          <div {...stylex.props(styles.recapMeta)}>Today · 38 min · Sam, Maya, Jo</div>
        </div>
        <div {...stylex.props(styles.recapTabs)}>
          <span {...stylex.props(styles.recapTab, styles.recapTabOn)}>Summary</span>
          <span {...stylex.props(styles.recapTab)}>PDF</span>
          <span {...stylex.props(styles.recapTab)}>Transcript</span>
          <span {...stylex.props(styles.recapTab)}>Recording</span>
        </div>
        <div {...stylex.props(styles.recapBody)}>
          <span>Weekend away on June 12–14, about €400 each.</span>
          <span>
            <span {...stylex.props(styles.strong)}>Maya</span> gets the train tickets.{" "}
            <span {...stylex.props(styles.strong)}>Sam</span> books the hotel.
          </span>
        </div>
      </div>
      <div {...stylex.props(styles.card, styles.search)}>
        <Search size={15} strokeWidth={2} />
        Search meetings and what was said
      </div>
    </div>
  );
}

function RoomsPicture() {
  return (
    <div aria-hidden="true" {...stylex.props(styles.well)}>
      <div {...stylex.props(styles.card, styles.linkCard)}>
        <div {...stylex.props(styles.linkText)}>
          <span {...stylex.props(styles.small)}>Your link</span>
          <span {...stylex.props(styles.linkCode)}>
            orbmeet.com/<span {...stylex.props(styles.accentText)}>abc-defg-hij</span>
          </span>
        </div>
        <span {...stylex.props(styles.copyChip)}>Copy</span>
      </div>
      <div {...stylex.props(styles.card, styles.spaceCard)}>
        <div {...stylex.props(styles.spaceHead)}>
          <span {...stylex.props(styles.spaceInitial)}>D</span>
          <span {...stylex.props(styles.spaceName)}>
            Design team
            <span {...stylex.props(styles.small)}>Space · 5 members</span>
          </span>
        </div>
        <div {...stylex.props(styles.history)}>
          <div {...stylex.props(styles.historyRow)}><span>Weekly check-in</span><span {...stylex.props(styles.small)}>Nov 9</span></div>
          <div {...stylex.props(styles.historyRow)}><span>Homepage review</span><span {...stylex.props(styles.small)}>Nov 5</span></div>
        </div>
      </div>
    </div>
  );
}

// ─── Tour ────────────────────────────────────────────────────────────────────

/** The sample call, right under the hero. */
export function LandingRoomShot() {
  return (
    <section aria-label="A call in Orb Meet" {...stylex.props(styles.wrap, styles.wideWrap, styles.shot)}>
      <SampleRoom />
    </section>
  );
}

/** Everything below the sample call, for visitors who aren't signed in. */
export function LandingTour() {
  return (
    <>
      <Feature id="tour-join" title="Send a link. They’re in." picture={<GuestJoinCard />}>
        No app to download, no account to make. Guests type their name and join from any browser, on a laptop or a phone.
      </Feature>

      <Feature id="tour-board" title="One tap from faces to the board." picture={<BoardTools />}>
        Everyone sees your page as you draw. Hand someone the pen when it’s their turn, or let people look around on
        their own. Write, sketch, add shapes and tables, or drop in a PDF to mark up together.
      </Feature>

      <section aria-labelledby="tour-orb" {...stylex.props(styles.wrap, styles.feature)}>
        <div {...stylex.props(styles.intro)}>
          <h2 id="tour-orb" {...stylex.props(styles.h2)}>A helper in every call.</h2>
          <p {...stylex.props(styles.lede)}>
            Type @Orb and it puts a list, a plan or a diagram on the board for everyone. Or ask it privately, and only
            you see the answer.
          </p>
        </div>
        <OrbDemo />
      </section>

      <Feature id="tour-after" title="Hang up with everything." picture={<RecapCard />}>
        Everyone, guests too, gets the board the moment the call ends. You get it all in your library: the board as a
        PDF, a transcript, a summary, and the recording if you made one. Search it any time.
      </Feature>

      <Feature id="tour-rooms" title="Rooms you come back to." picture={<RoomsPicture />}>
        Your own link never changes, so people always know where to find you. For a group that meets often, make a
        Space: one link, shared boards that carry over between calls, and every meeting in one place.
      </Feature>

      <section aria-labelledby="tour-also" {...stylex.props(styles.wrap, styles.feature)}>
        <h2 id="tour-also" {...stylex.props(styles.alsoTitle)}>Also in every call</h2>
        <ul {...stylex.props(styles.alsoList)}>
          {ALSO.map(({ title, body }) => (
            <li key={title} {...stylex.props(styles.alsoItem)}>
              <span {...stylex.props(styles.alsoName)}>{title}</span>
              {body}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/**
 * The landing film's own colours. The film is an illustration of a call, pinned
 * light, so its people, paper and shadows are fixed values rather than theme tokens.
 */
import * as stylex from "@stylexjs/stylex";

export const film = stylex.defineConsts({
  stageShadow: "0 60px 100px -70px rgba(45,28,130,.55), 0 0 0 1px rgba(22,22,27,.06)",
  statusText: "#047857",
  statusDot: "#10b981",
  modeShadow: "0 1px 3px rgba(22,22,27,.14)",
  leave: "#dc2626",
  mayaBackdrop: "#9fd8bf",
  mayaInitial: "#065f46",
  priyaBackdrop: "#c4b8f5",
  priyaInitial: "#2d1c82",
  samBackdrop: "#f3c98a",
  samInitial: "#80500a",
  nameplate: "rgba(11,11,15,.68)",
  speakingRing: "inset 0 0 0 3px #34d399",
  caption: "rgba(22,22,27,.9)",
  paper: "#ffffff",
  pageShadow: "0 2px 10px rgba(22,22,27,.1)",
  windowShadow: "0 18px 44px -18px rgba(22,22,27,.45)",
  orbBubble: "#f7f5ff",
  spotlight: "0 0 0 2400px rgba(238,238,241,.93)",
  docShadow: "0 40px 60px -46px rgba(45,28,130,.5)",
  docArt: "#f7f7f9",
  scrubTrack: "rgba(255,255,255,.45)",
});

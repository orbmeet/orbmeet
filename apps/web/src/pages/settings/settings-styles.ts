/**
 * Styles shared across the Settings sections.
 *
 * Settings is a page of near-identical rows — a device, a linked account, an
 * API key — each one a bordered box with an identity on the left and an action
 * on the right. They were the same class string copied into four files, which
 * is how one of them ended up with a different border radius. One definition
 * here, and the sections describe only what is different about their row.
 */
import { danger, ink, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

export const settings = stylex.create({
  /** One item in a list of things you own: a device, a key, a connection. */
  itemRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    padding: space.s4,
  },
  /** The name of that thing. */
  itemName: {
    margin: 0,
    fontSize: text.base,
    lineHeight: leading.base,
    fontWeight: weight.medium,
    color: ink.strong,
  },
  /** The line under it: an address, a timestamp, a connection state. */
  itemMeta: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  itemMetaSpaced: { marginTop: space.s1 },
  /** A square tile holding a provider mark or a device glyph. */
  itemGlyph: {
    display: "flex",
    height: 40,
    width: 40,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.field,
    backgroundColor: neutral.n100,
  },
  /** Explanatory prose introducing a group of rows. */
  blurb: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.muted,
  },
  /**
   * A bordered list of rows sharing hairlines, rather than each row carrying
   * its own box. One border around the group and a rule between neighbours is
   * the difference between a table and a pile of cards.
   */
  list: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    overflow: "hidden",
  },
  listRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s4,
    padding: space.s4,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: neutral.n100,
  },
  /** The first row has the group's own border above it already. */
  listRowFirst: { borderTopWidth: 0 },
  /** An empty list still has to say something. */
  listEmpty: {
    padding: space.s4,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },

  /** A quiet inset panel holding a form — "add a member", "create a key". */
  formPanel: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: neutral.n50,
    padding: space.s4,
  },

  /** A short box holding a spinner while a section loads. */
  loading: {
    display: "flex",
    height: "6rem",
    alignItems: "center",
    justifyContent: "center",
  },
  loadingShort: { height: "5rem" },

  /** A failure message under the control that caused it. */
  error: {
    marginTop: space.s3,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: danger.d600,
  },
  errorFlush: { marginTop: 0 },

  /** A sub-heading inside a section. */
  subhead: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  /** The fine print under one. */
  fine: {
    marginTop: space.s1,
    marginBottom: 0,
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: ink.muted,
  },

  /** A footnote under a field. */
  hint: {
    marginTop: space.s1,
    marginBottom: 0,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },
});

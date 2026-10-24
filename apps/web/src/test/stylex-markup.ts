import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

/**
 * Assertions about rendered StyleX markup.
 *
 * StyleX compiles to one hashed class per *declaration*, hashed from the
 * declaration itself — not from the style's name or its file. A style written
 * here with the same declarations a component uses therefore produces the
 * same classes the component ships: the assertion checks the declaration
 * ("this box has a fixed height") without pinning StyleX's class naming, the
 * same honesty rule `ui-wrappers.test.tsx` states for its `classOf` helper.
 *
 * Use `hasStyle` to ask whether any rendered element carries a style.
 */

/** The classes a style compiles to — one per declaration it sets. */
export function classesOf(style: StyleXStyles): string[] {
  return (stylex.props(style).className ?? "").split(" ").filter(Boolean);
}

/** Whether an element's class attribute carries every declaration in `style`. */
function carriesClassAttribute(tag: string, classes: string[]): boolean {
  const attr = /class="([^"]*)"/.exec(tag)?.[1] ?? "";
  const present = attr.split(" ");
  return classes.every((cls) => present.includes(cls));
}

/** Whether `markup` contains any element carrying every declaration in `style`. */
export function hasStyle(markup: string, style: StyleXStyles): boolean {
  const classes = classesOf(style);
  return markup
    .split(/(?=<[a-z])/)
    .some((tag) => carriesClassAttribute(tag, classes));
}

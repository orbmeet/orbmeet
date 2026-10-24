/**
 * Variables an ancestor publishes for a descendant to read.
 *
 * StyleX has no `group-hover:`, and that is the point — "style this element
 * when some other element is hovered" is exactly the rule that breaks when
 * either element moves. A variable makes the contract explicit in both
 * directions: the ancestor declares what it publishes, and the descendant
 * declares that it is reading it and can still override the result locally.
 *
 * Each variable names the *relationship*, not the property, so it is obvious
 * at the ancestor which descendants a hover state is reaching.
 */
import * as stylex from "@stylexjs/stylex";

export const railVars = stylex.defineVars({
  /**
   * How visible an insert caret is. The page list raises it on hover, so the
   * carets appear as a set; each caret still goes fully opaque on its own
   * hover or focus.
   */
  caretOpacity: "0",
  /** The append button turns its `+` into an `×`-adjacent tilt on hover. */
  addIconRotation: "0deg",
});

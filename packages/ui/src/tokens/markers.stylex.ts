/**
 * Named contextual-selector markers.
 *
 * `stylex.when.ancestor(...)` compiles to `:where(.<marker>:state *)`, so a
 * rule only resolves when some ancestor actually carries the marker class.
 * `stylex.defaultMarker()` covers the common case — one element is the group
 * and everything inside reads its state.
 *
 * These exist for the case `defaultMarker()` cannot express: two *nested*
 * groups whose states mean different things. A `<details>` owns the open
 * state while the `<summary>` inside it owns the hover state; with a single
 * marker the inner element would answer to whichever ancestor happened to be
 * marked, and hovering the opened body would light up the header.
 *
 * Markers are compile-time identities, like `defineVars`, so they have to live
 * in a `.stylex.ts` module — a `defineMarker()` call in an ordinary file fails
 * to compile.
 */
import * as stylex from "@stylexjs/stylex";

/**
 * The outer element of a disclosure — the `<details>` that owns `[open]`.
 *
 * Pair it with `defaultMarker()` on the `<summary>` inside, so the header's
 * hover and the disclosure's open state stay separately addressable.
 */
export const disclosure = stylex.defineMarker();

/**
 * Shared deterministic gradient picker for Spaces.
 *
 * Every Space surface — the row in `/spaces`, the detail header, Home's Spaces
 * strip — reads its tile from here, so the same Space name always maps to the
 * same colour bucket everywhere. Six buckets, in a fixed order: reorder the
 * list and every Space changes colour.
 *
 * The gradients are `stylex.create` namespaces rather than class-name strings,
 * so a caller applies one alongside its own styles instead of concatenating a
 * class it cannot override.
 *
 * Both stops of every pair come from `spaceTile`. Mixing brand tokens and raw
 * hex would let a palette change move half these gradients and leave the other
 * half behind — see the docblock on the token group.
 */
import { hashStringToIndex } from "@orbmeet/ui/gradient-hash";
import * as stylex from "@stylexjs/stylex";
import { spaceTile } from "@orbmeet/ui/tokens/colors.stylex";

const gradients = stylex.create({
  g0: { backgroundImage: `linear-gradient(to bottom right, ${spaceTile.from1}, ${spaceTile.to1})` },
  g1: { backgroundImage: `linear-gradient(to bottom right, ${spaceTile.from2}, ${spaceTile.to2})` },
  g2: { backgroundImage: `linear-gradient(to bottom right, ${spaceTile.from3}, ${spaceTile.to3})` },
  g3: { backgroundImage: `linear-gradient(to bottom right, ${spaceTile.from4}, ${spaceTile.to4})` },
  g4: { backgroundImage: `linear-gradient(to bottom right, ${spaceTile.from5}, ${spaceTile.to5})` },
  g5: { backgroundImage: `linear-gradient(to bottom right, ${spaceTile.from6}, ${spaceTile.to6})` },
});

const ORDERED = [
  gradients.g0,
  gradients.g1,
  gradients.g2,
  gradients.g3,
  gradients.g4,
  gradients.g5,
] as const;

export function getSpaceGradient(name: string) {
  return ORDERED[hashStringToIndex(name, ORDERED.length)];
}

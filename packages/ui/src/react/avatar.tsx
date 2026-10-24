import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

import { identity, live, neutral, surface } from "../tokens/colors.stylex";
import { radii } from "../tokens/radii.stylex";
import { leading, text, weight } from "../tokens/typography.stylex";
import { hashStringToIndex } from "./gradient-hash";

const sizes = stylex.create({
  sm: { width: 32, height: 32, fontSize: text.xs },
  md: { width: 40, height: 40, fontSize: text.sm },
  lg: { width: 48, height: 48, fontSize: text.base },
  xl: { width: 64, height: 64, fontSize: text.lg },
});

type AvatarSize = keyof typeof sizes;

/**
 * The identity palette, in order.
 *
 * `hashStringToIndex` maps a name onto one of these, so the list's length and
 * order are what keep a given person's colour stable — reorder it and
 * everyone's avatar changes.
 *
 * These are `identity.*` rather than steps borrowed from the brand scales
 * because they answer a different question: brand scales move when the brand
 * is retuned, and someone's initials should not.
 */
const identities = stylex.create({
  i0: { backgroundColor: identity.surface1, color: identity.ink1 },
  i1: { backgroundColor: identity.surface2, color: identity.ink2 },
  i2: { backgroundColor: identity.surface3, color: identity.ink3 },
  i3: { backgroundColor: identity.surface4, color: identity.ink4 },
  i4: { backgroundColor: identity.surface5, color: identity.ink5 },
  i5: { backgroundColor: identity.surface6, color: identity.ink6 },
  i6: { backgroundColor: identity.surface7, color: identity.ink7 },
  i7: { backgroundColor: identity.surface8, color: identity.ink8 },
});

const identityByIndex = [
  identities.i0,
  identities.i1,
  identities.i2,
  identities.i3,
  identities.i4,
  identities.i5,
  identities.i6,
  identities.i7,
] as const;

const styles = stylex.create({
  wrapper: { position: "relative", flexShrink: 0, display: "inline-block" },
  root: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
    overflow: "hidden",
    fontWeight: weight.medium,
    // A size container, so the initials scale to the actual circle even when a
    // caller overrides the box. `40cqmin` below is what reads that.
    containerType: "size",
  },
  /** An exact diameter, for a caller whose size is measured rather than chosen. */
  measured: (px: number) => ({ width: px, height: px }),
  image: { width: "100%", height: "100%", objectFit: "cover" },
  fallback: {
    display: "flex",
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: leading.xl5,
    // Sized off the container above rather than off the `size` step, so a
    // measured avatar gets proportional initials for free.
    fontSize: "40cqmin",
  },
  dot: {
    position: "absolute",
    right: 0,
    bottom: 0,
    display: "block",
    borderRadius: radii.pill,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: surface.raised,
  },
  dotSm: { width: 8, height: 8 },
  dotMd: { width: 10, height: 10 },
  dotOnline: { backgroundColor: live.l500 },
  dotOffline: { backgroundColor: neutral.n400 },
});

function getInitials(name: string): string {
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return (trimmed[0] || "?").toUpperCase();
}

interface AvatarProps {
  name: string;
  image?: string | null;
  size?: AvatarSize;
  /**
   * An exact diameter in px, for callers whose size is measured rather than
   * chosen — a gallery tile fitted to the stage has no step on the `size`
   * scale that fits it. Overrides `size`; the initials follow on their own,
   * because they are sized in container units off this box.
   */
  sizePx?: number;
  online?: boolean;
  sx?: StyleXStyles;
}

export function Avatar({ name, image, size = "md", sizePx, online, sx }: AvatarProps) {
  const colorIndex = hashStringToIndex(name, identityByIndex.length);

  return (
    <div {...stylex.props(styles.wrapper)}>
      <BaseAvatar.Root
        // Avatar.Root is a bare <span>; ARIA does not allow naming a generic
        // element, so the name only lands if the element is an image. With
        // role="img" its children are presentational, which is what we want —
        // the photo or the initials both stand for the same person.
        role="img"
        // The status dot is colour alone, so its meaning rides on the name.
        aria-label={online === undefined ? name : `${name}, ${online ? "online" : "offline"}`}
        {...stylex.props(
          styles.root,
          sizePx === undefined ? sizes[size] : styles.measured(sizePx),
          identityByIndex[colorIndex],
          sx,
        )}
      >
        {image ? (
          <BaseAvatar.Image src={image} alt={name} {...stylex.props(styles.image)} />
        ) : null}
        {/* No photo → initials on the per-name pastel above. We never guess a
            face for someone, and a plain monogram nudges people to add a photo. */}
        <BaseAvatar.Fallback delay={image ? 300 : undefined} {...stylex.props(styles.fallback)}>
          {getInitials(name)}
        </BaseAvatar.Fallback>
      </BaseAvatar.Root>
      {online !== undefined && (
        <span
          aria-hidden
          {...stylex.props(
            styles.dot,
            size === "sm" ? styles.dotSm : styles.dotMd,
            online ? styles.dotOnline : styles.dotOffline,
          )}
        />
      )}
    </div>
  );
}

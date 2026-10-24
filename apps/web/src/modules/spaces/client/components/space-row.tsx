import { Badge } from "@orbmeet/ui/react";
import { focus, layout, motion } from "@orbmeet/ui/styles/atoms";
import { accent, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Users } from "lucide-react";

const styles = stylex.create({
  row: {
    display: "flex", flexDirection: "column", height: "100%", minHeight: 224,
    gap: space.s4, padding: space.s5, borderRadius: 20,
    borderWidth: 1, borderStyle: "solid",
    borderColor: { default: neutral.n150, [env.hoverable]: { default: neutral.n150, ":hover": accent.a200 } },
    backgroundColor: surface.raised,
    boxShadow: { default: shadows.lift1, [env.hoverable]: { default: shadows.lift1, ":hover": shadows.lift2 } },
    textDecorationLine: "none",
  },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.s3 },
  footer: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.s2, paddingTop: space.s3, borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: neutral.n100, color: ink.muted, fontSize: text.xs },
  footerLabel: { display: "inline-flex", alignItems: "center", gap: space.s2 },
  tile: {
    display: "flex",
    height: 44,
    width: 44,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
    fontSize: text.sm,
    fontWeight: weight.bold,
    color: ink.onDark,
  },
  body: { minWidth: 0, flexGrow: 1, width: "100%" },
  name: {
    display: "block",
    overflowWrap: "anywhere",
    fontSize: text.base,
    fontWeight: weight.semibold,
    color: { default: neutral.n800, [env.hoverable]: { default: neutral.n800, [stylex.when.ancestor(":hover")]: accent.a700 } },
  },
  badge: { flexShrink: 0, fontSize: text.xs2 },
  meta: {
    marginTop: space.s2,
    display: "block",
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  /** Leans out of the row on hover, the way a link that goes somewhere should. */
  chevron: {
    flexShrink: 0,
    color: { default: neutral.n300, [env.hoverable]: { default: neutral.n300, [stylex.when.ancestor(":hover")]: accent.a500 } },
    transform: { default: "translateX(0)", [env.hoverable]: { default: "translateX(0)", [stylex.when.ancestor(":hover")]: "translateX(2px)" } },
  },
});
import { getSpaceGradient } from "@/modules/spaces/client/space-gradient";
import { spaceRoleBadgeVariant } from "@/modules/spaces/client/space-role-badge";

interface SpaceRowProps {
  slug: string;
  name: string;
  description?: string | null;
  accessLabel: string;
  accessLevel: "owner" | "admin" | "member";
  billingLabel: string | null;
}

/** A Space card in the workspace library. */
export function SpaceRow({
  slug,
  name,
  description,
  accessLabel,
  accessLevel,
  billingLabel,
}: SpaceRowProps) {
  const gradient = getSpaceGradient(name);
  const meta = description?.trim() || "Meet, share ideas, and keep your group’s work together.";

  return (
    <Link
      to="/space/$spaceSlug"
      params={{ spaceSlug: slug }}
      {...stylex.props(styles.row, focus.ring, motion.tint, stylex.defaultMarker())}
    >
      <span {...stylex.props(styles.head)}>
        <span {...stylex.props(styles.tile, gradient)}>{name.charAt(0).toUpperCase()}</span>
        <Badge variant={spaceRoleBadgeVariant[accessLevel]} sx={styles.badge}>{accessLabel}</Badge>
      </span>
      <span {...stylex.props(styles.body)}>
        <span {...stylex.props(styles.name, motion.tint)}>{name}</span>
        <span {...stylex.props(styles.meta)}>{meta}</span>
      </span>
      <span {...stylex.props(styles.footer)}>
        <span {...stylex.props(styles.footerLabel, layout.truncate)}><Users size={14} />{billingLabel ?? "Members only"}</span>
        <ArrowUpRight size={16} {...stylex.props(styles.chevron, motion.move)} />
      </span>
    </Link>
  );
}

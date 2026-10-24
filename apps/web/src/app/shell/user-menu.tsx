import {
  Avatar,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuLinkItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "@orbmeet/ui/react";
import { focus, layout, motion } from "@orbmeet/ui/styles/atoms";
import { danger, ink, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { ChevronDown, LogOut, Settings } from "lucide-react";

import { mainNavItems } from "./nav-items";

const OPEN = ":is([data-popup-open])";
const HIGHLIGHTED = ":is([data-highlighted])";

const styles = stylex.create({
  triggerBase: {
    borderWidth: 0,
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  /** Avatar-only, for the navigation rail. */
  compact: {
    borderRadius: radii.pill,
    padding: space.s0_5,
    boxShadow: { default: "none", [env.hoverable]: { default: "none", ":hover": `0 0 0 4px ${neutral.n100}` } },
  },
  /** Avatar plus identity, for the wide header. */
  wide: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n200 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    padding: space.s1_5,
    paddingRight: space.s2,
  },
  identity: {
    display: { default: "none", [bp.md]: "block" },
    minWidth: 0,
    textAlign: "start",
  },
  name: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    color: neutral.n800,
  },
  email: {
    margin: 0,
    maxWidth: 140,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },
  /** Follows the popup, so the control reads as the thing that opened it. */
  chevron: {
    flexShrink: 0,
    color: neutral.n500,
    transform: {
      default: "rotate(0deg)",
      [stylex.when.ancestor(OPEN)]: "rotate(180deg)",
    },
  },

  popup: { width: 240, padding: space.s2 },
  group: { paddingBlock: space.s1 },
  identityLabel: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    paddingInline: space.s3,
    paddingBlock: space.s3,
    marginBottom: space.s1,
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: neutral.n800,
    textTransform: "none",
    letterSpacing: "normal",
  },
  labelText: { minWidth: 0 },
  labelName: {
    display: "block",
    fontSize: text.sm,
    fontWeight: weight.semibold,
    color: neutral.n800,
  },
  labelEmail: {
    display: "block",
    fontSize: text.xs,
    fontWeight: weight.normal,
    color: ink.muted,
  },
  itemIcon: { color: neutral.n500 },
  signOut: {
    marginTop: space.s1,
    color: { default: danger.d600, [HIGHLIGHTED]: danger.d700 },
    backgroundColor: { default: "transparent", [HIGHLIGHTED]: danger.d50 },
  },
});

interface UserMenuProps {
  user: {
    name: string;
    email: string;
    image?: string | null;
  };
  onLogout: () => void;
  /** Avatar-only trigger for the navigation rail. */
  compact?: boolean;
}

export function UserMenu({ user, onLogout, compact }: UserMenuProps) {
  return (
    <MenuRoot>
      {compact ? (
        <MenuTrigger
          aria-label="Account"
          {...stylex.props(styles.triggerBase, styles.compact, motion.tint, focus.ring)}
        >
          <Avatar name={user.name} image={user.image} size="sm" />
        </MenuTrigger>
      ) : (
        <MenuTrigger
          {...stylex.props(
            styles.triggerBase,
            styles.wide,
            motion.tint,
            focus.ring,
            stylex.defaultMarker(),
          )}
        >
          <Avatar name={user.name} image={user.image} size="sm" />
          <div {...stylex.props(styles.identity)}>
            <p {...stylex.props(styles.name, layout.truncate)}>{user.name}</p>
            <p {...stylex.props(styles.email, layout.truncate)}>{user.email}</p>
          </div>
          <ChevronDown size={14} {...stylex.props(styles.chevron, motion.move)} />
        </MenuTrigger>
      )}

      <MenuContent
        side={compact ? "right" : "bottom"}
        align="end"
        sideOffset={8}
        sx={styles.popup}
      >
        {/* A role="menu" may only own menuitem / group / separator children, so
            the identity block and the link list are one labelled group rather
            than two bare divs. */}
        <MenuGroup {...stylex.props(styles.group)}>
          <MenuGroupLabel sx={styles.identityLabel}>
            <Avatar name={user.name} image={user.image} size="md" />
            <span {...stylex.props(styles.labelText)}>
              <span {...stylex.props(styles.labelName, layout.truncate)}>{user.name}</span>
              <span {...stylex.props(styles.labelEmail, layout.truncate)}>{user.email}</span>
            </span>
          </MenuGroupLabel>

          <MenuSeparator />

          {mainNavItems.map((item) => (
            <MenuLinkItem key={item.to} render={<Link to={item.to} />}>
              <item.icon size={16} {...stylex.props(styles.itemIcon)} />
              {item.label}
            </MenuLinkItem>
          ))}
          <MenuLinkItem render={<Link to="/settings" />}>
            <Settings size={16} {...stylex.props(styles.itemIcon)} />
            Settings
          </MenuLinkItem>
        </MenuGroup>

        <MenuSeparator />

        <MenuItem onClick={onLogout} sx={styles.signOut}>
          <LogOut size={16} />
          Sign out
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}

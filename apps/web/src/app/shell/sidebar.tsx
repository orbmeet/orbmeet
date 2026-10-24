import { BrandMark } from "@orbmeet/ui/react";
import { focus, layout, motion } from "@orbmeet/ui/styles/atoms";
import { border, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { Plus, Search } from "lucide-react";

import { mySpacesQueryOptions } from "@/app/query-client/queries/spaces";
import { CreateSpaceDialog } from "@/modules/spaces/client/components/create-space-dialog";
import { SpaceTile } from "@/modules/spaces/client/components/space-tile";
import { mainNavItems } from "./nav-items";
import { UserMenu } from "./user-menu";

/** The rail lists this many Spaces by name; past it, "All spaces" lists the rest. */
const RAIL_SPACE_LIMIT = 8;

const styles = stylex.create({
  rail: {
    // The rail sits on the page ground, not on a card: the page beside it is
    // the card. It is navigation only — every page owns its own primary
    // action, so nothing here competes with it.
    position: "sticky",
    top: 0,
    zIndex: 40,
    display: { default: "none", [bp.lg]: "flex" },
    height: "100vh",
    width: 236,
    flexShrink: 0,
    flexDirection: "column",
    gap: space.s1,
    boxSizing: "border-box",
    paddingInline: space.s2,
    paddingTop: space.s4,
    paddingBottom: space.s3,
    overflowY: "auto",
  },
  /**
   * Beside a board, the rail is only kept where it costs the board little:
   * on a landscape tablet it, the page list and the tools took 40% of the
   * width. The board's own header has the way back.
   */
  railBesideCanvas: { display: { default: "none", [bp.xl]: "flex" } },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    paddingInline: space.s2_5,
    paddingBottom: space.s4,
    color: ink.strong,
    textDecorationLine: "none",
    fontFamily: fonts.heading,
    fontSize: text.base,
    fontWeight: weight.semibold,
    letterSpacing: "-0.02em",
  },
  search: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    height: 36,
    marginBottom: space.s2_5,
    paddingInline: space.s2_5,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    borderRadius: 10,
    backgroundColor: surface.raised,
    color: ink.muted,
    fontSize: text.sm,
    textDecorationLine: "none",
  },
  searchLabel: { flexGrow: 1 },
  kbd: {
    // A keyboard shortcut means nothing to a finger.
    display: { default: null, [env.touch]: "none" },
    fontFamily: fonts.mono,
    fontSize: "0.6875rem",
    lineHeight: 1.4,
    color: ink.muted,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    borderRadius: 5,
    paddingInline: 5,
  },
  /**
   * Every row in the rail is one of these: an icon or tile, then a label, 36px
   * tall. Active and idle differ by ground and weight, not by colour.
   */
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    minHeight: 36,
    paddingInline: space.s2_5,
    borderRadius: 10,
    fontSize: text.sm,
    textDecorationLine: "none",
  },
  idle: {
    color: neutral.n700,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n150 } },
  },
  // The page is a raised card, so the row you are on is a small one too.
  active: {
    color: ink.strong,
    fontWeight: weight.medium,
    backgroundColor: surface.raised,
    boxShadow: `0 0 0 1px ${border.base}`,
  },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingInlineStart: space.s2_5,
    paddingInlineEnd: space.s1,
    paddingTop: space.s5,
    paddingBottom: space.s1_5,
  },
  sectionLabel: {
    margin: 0,
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: ink.muted,
  },
  addSpace: {
    display: "grid",
    placeItems: "center",
    width: { default: 28, [env.touch]: 40 },
    height: { default: 28, [env.touch]: 40 },
    padding: 0,
    borderWidth: 0,
    borderRadius: 7,
    color: ink.muted,
    cursor: "pointer",
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n150 } },
  },
  /** The link around a row: the row is what you see, the link only carries it. */
  anchor: { display: "block", borderRadius: 10, textDecorationLine: "none", color: "inherit" },
  list: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: space.s0_5 },
  spaceName: { minWidth: 0, flexGrow: 1 },
  more: { color: ink.muted },
  bottom: {
    marginTop: "auto",
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    paddingTop: space.s4,
  },
  you: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    paddingInlineStart: space.s1,
  },
  youLink: { flexGrow: 1, minWidth: 0 },
  youRow: { minHeight: 44, flexDirection: "column", alignItems: "flex-start", justifyContent: "center", gap: 0, lineHeight: 1.25 },
  youName: { maxWidth: "100%", fontSize: text.sm, fontWeight: weight.medium, color: ink.strong },
  youHint: { fontSize: text.xs, fontWeight: weight.normal, color: ink.muted },
});

interface SidebarProps {
  /** Rendered above the account controls — the install offer, when there is one. */
  offer?: ReactNode;
  /** The page is a full-bleed canvas: keep the rail only on a wide screen. */
  besideCanvas?: boolean;
  user: { name: string; email: string; image?: string | null };
  onLogout: () => void;
}

function RailItem({ active, children, sx }: { active: boolean; children: ReactNode; sx?: stylex.StyleXStyles }) {
  return <span {...stylex.props(styles.item, motion.tint, active ? styles.active : styles.idle, sx)}>{children}</span>;
}

/**
 * The search shortcut as this device spells it. The server cannot know the
 * platform, so the first paint says ⌘K and a non-Apple device corrects it
 * once mounted.
 */
function useSearchShortcutLabel(): string {
  const [label, setLabel] = useState("⌘K");
  useEffect(() => {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
    if (!/mac|iphone|ipad/i.test(platform)) setLabel("Ctrl K");
  }, []);
  return label;
}

/**
 * The desktop rail: where to go, and nothing to do. Home, Calendar and the
 * Library, then each of your Spaces by name, then you.
 */
export function Sidebar({ user, onLogout, offer, besideCanvas = false }: SidebarProps) {
  const [creatingSpace, setCreatingSpace] = useState(false);
  // The rail must never hold a page up, so it reads Spaces without suspending
  // and simply shows none until they arrive.
  const { data } = useQuery(mySpacesQueryOptions());
  const spaces = data?.spaces ?? [];
  const listed = spaces.slice(0, RAIL_SPACE_LIMIT);
  const shortcut = useSearchShortcutLabel();

  return (
    <aside {...stylex.props(styles.rail, besideCanvas && styles.railBesideCanvas)}>
      <Link to="/home" {...stylex.props(styles.brand, focus.ring)}>
        <BrandMark size={22} />
        Orb Meet
      </Link>

      <Link to="/library" search={{ find: true }} {...stylex.props(styles.search, motion.tint, focus.ring)}>
        <Search size={16} strokeWidth={1.9} aria-hidden="true" />
        <span {...stylex.props(styles.searchLabel)}>Search or join…</span>
        <kbd {...stylex.props(styles.kbd)}>{shortcut}</kbd>
      </Link>

      <nav aria-label="Primary navigation">
        <ul {...stylex.props(styles.list)}>
          {mainNavItems.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <Link to={to} {...stylex.props(styles.anchor, focus.ring)}>
                {({ isActive }) => (
                  <RailItem active={isActive}>
                    <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
                    {label}
                  </RailItem>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <nav aria-labelledby="rail-spaces">
        <div {...stylex.props(styles.sectionHead)}>
          <h2 id="rail-spaces" {...stylex.props(styles.sectionLabel)}>Spaces</h2>
          <button
            type="button"
            aria-label="New space"
            title="New space"
            onClick={() => setCreatingSpace(true)}
            {...stylex.props(styles.addSpace, motion.tint, focus.ring)}
          >
            <Plus size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <ul {...stylex.props(styles.list)}>
          {listed.map((listedSpace) => (
            <li key={listedSpace.id}>
              <Link to="/space/$spaceSlug" params={{ spaceSlug: listedSpace.slug }} {...stylex.props(styles.anchor, focus.ring)}>
                {({ isActive }) => (
                  <RailItem active={isActive}>
                    <SpaceTile name={listedSpace.name} />
                    <span {...stylex.props(styles.spaceName, layout.truncate)}>{listedSpace.name}</span>
                  </RailItem>
                )}
              </Link>
            </li>
          ))}
          {spaces.length > RAIL_SPACE_LIMIT && (
            <li>
              <Link to="/spaces" {...stylex.props(styles.anchor, focus.ring)}>
                {({ isActive }) => (
                  <RailItem active={isActive}>
                    <span {...stylex.props(styles.more)}>All spaces</span>
                  </RailItem>
                )}
              </Link>
            </li>
          )}
          <li>
            <Link to="/library" search={{ scope: "personal" }} activeOptions={{ includeSearch: true }} {...stylex.props(styles.anchor, focus.ring)}>
              {({ isActive }) => (
                <RailItem active={isActive}>
                  <SpaceTile name="Personal" personal />
                  Personal
                </RailItem>
              )}
            </Link>
          </li>
        </ul>
      </nav>

      <div {...stylex.props(styles.bottom)}>
        {offer}
        <div {...stylex.props(styles.you)}>
          <UserMenu compact user={user} onLogout={onLogout} />
          {/* Settings is said, not only drawn: the row under your name is the way in. */}
          <Link to="/settings" {...stylex.props(styles.anchor, styles.youLink, focus.ring)}>
            {({ isActive }) => (
              <RailItem active={isActive} sx={styles.youRow}>
                <span {...stylex.props(styles.youName, layout.truncate)}>{user.name}</span>
                <span {...stylex.props(styles.youHint)}>Settings</span>
              </RailItem>
            )}
          </Link>
        </div>
      </div>

      <CreateSpaceDialog open={creatingSpace} onOpenChange={setCreatingSpace} />
    </aside>
  );
}

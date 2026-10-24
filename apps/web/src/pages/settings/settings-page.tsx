import { getRouteApi, Link } from "@tanstack/react-router";
import { Card, Spinner } from "@orbmeet/ui/react";
import type * as React from "react";
import { Suspense, useEffect } from "react";
import { ChevronRight } from "lucide-react";
import { focus, motion } from "@orbmeet/ui/styles/atoms";
import { surfaces } from "@orbmeet/ui/styles/surfaces";
import { accent, border, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { AppearanceSection } from "@/pages/settings/components/appearance-section";
import { DangerZoneSection } from "@/pages/settings/components/danger-zone-section";
import { LinkedAccountsSection } from "@/pages/settings/components/linked-accounts-section";
import { MeetingsSection } from "@/pages/settings/components/meetings-section";
import { OrbSection } from "@/pages/settings/components/orb-section";
import { OrganizationSection } from "@/pages/settings/components/organization-section";
import { PlanSection } from "@/pages/settings/components/plan-section";
import { ProfileSection } from "@/pages/settings/components/profile-section";
import { SecuritySection } from "@/pages/settings/components/security-section";
import { SessionsSection } from "@/pages/settings/components/sessions-section";
import { DeveloperApiSection } from "@/pages/settings/components/developer-api-section";
import { settingsPageOf, type SettingsTabId } from "@/pages/settings/settings-tabs";
import { useAuthenticatedSession } from "@/app/query-client/use-authenticated-session";

const routeApi = getRouteApi("/_authed/settings/");

const styles = stylex.create({
  page: {
    maxWidth: 820,
    marginInline: "auto",
    display: "flex",
    flexDirection: "column",
    gap: space.s5,
    paddingTop: { default: space.s4, [bp.lg]: space.s7 },
  },
  header: { display: "flex", flexDirection: "column", gap: space.s2, paddingBottom: space.s2 },
  crumb: { fontSize: "0.84375rem", fontWeight: weight.medium, color: accent.a700, textDecorationLine: "none" },
  title: {
    margin: 0,
    fontFamily: fonts.heading,
    fontWeight: weight.semibold,
    fontSize: { default: "2rem", [bp.sm]: "2.5rem" },
    lineHeight: 1.05,
    letterSpacing: "-0.045em",
    color: ink.strong,
  },
  lead: { margin: 0, fontSize: text.sm, color: ink.muted },
  /** The main page: a list of its sections beside them, from a laptop up. */
  wide: { maxWidth: 1040 },
  layout: { display: "flex", alignItems: "flex-start", gap: space.s10 },
  toc: {
    display: { default: "none", [bp.lg]: "flex" },
    position: "sticky",
    top: space.s7,
    flexDirection: "column",
    gap: 2,
    flexShrink: 0,
    width: 184,
  },
  tocLink: {
    display: "block",
    paddingBlock: space.s2,
    paddingInline: space.s3,
    borderRadius: 8,
    fontSize: text.sm,
    color: ink.muted,
    textDecorationLine: "none",
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  tocRule: { height: 1, marginBlock: space.s2, marginInline: space.s3, backgroundColor: border.subtle },
  sections: { display: "flex", flexDirection: "column", gap: space.s5, flexGrow: 1, minWidth: 0 },
  panelBody: { padding: { default: space.s5, [bp.md]: space.s7 } },
  // Whichever section an old `?tab=` link names lands below the page's top edge.
  anchor: { scrollMarginTop: space.s6 },
  spinnerRow: { display: "flex", height: 160, alignItems: "center", justifyContent: "center" },
  more: { display: "flex", flexDirection: "column", gap: space.s3 },
  moreLink: {
    display: "flex",
    alignItems: "center",
    gap: space.s4,
    paddingInline: space.s5,
    paddingBlock: space.s4,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.subtle,
    borderRadius: 18,
    color: ink.strong,
    textDecorationLine: "none",
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": neutral.n50 } },
  },
  moreText: { display: "flex", flexDirection: "column", gap: 2, flexGrow: 1, minWidth: 0 },
  moreTitle: { fontSize: text.base, fontWeight: weight.semibold },
  moreNote: { fontSize: "0.8125rem", color: ink.muted },
  chevron: { color: ink.muted, flexShrink: 0 },
});

/** The main page's sections, in the order they appear. */
const TOC = [
  ["profile", "Profile"],
  ["appearance", "Appearance"],
  ["meetings", "Meetings"],
  ["privacy", "Orb"],
] as const;

function SectionSpinner() {
  return (
    <div {...stylex.props(styles.spinnerRow)}>
      <Spinner size="md" brand />
    </div>
  );
}

/** One section on its panel, addressable by the old tab id that named it. */
function Panel({ id, danger, children }: { id: SettingsTabId | "appearance" | "meetings"; danger?: boolean; children: React.ReactNode }) {
  return (
    <div id={`settings-${id}`} {...stylex.props(styles.anchor)}>
      <Card sx={[styles.panelBody, danger ? surfaces.danger : null]}>{children}</Card>
    </div>
  );
}

function Header({ title, lead, back }: { title: string; lead: string; back?: boolean }) {
  return (
    <header {...stylex.props(styles.header)}>
      {back ? (
        <Link to="/settings" {...stylex.props(styles.crumb, motion.tint, focus.ring)}>
          ← Settings
        </Link>
      ) : null}
      <h1 {...stylex.props(styles.title)}>{title}</h1>
      <p {...stylex.props(styles.lead)}>{lead}</p>
    </header>
  );
}

/**
 * Settings: one page for what people change, and a page each for the
 * account's safety and its billing, which they rarely visit. Every section
 * that used to be a tab is still here; an old `?tab=` link opens its page,
 * scrolled to it.
 */
export function SettingsPage() {
  const { session: initialSession } = routeApi.useRouteContext();
  const session = useAuthenticatedSession(initialSession);
  const user = session.user;
  const { tab } = routeApi.useSearch();
  const page = settingsPageOf(tab);

  useEffect(() => {
    if (!tab) return;
    document.getElementById(`settings-${tab}`)?.scrollIntoView({ block: "start" });
  }, [tab]);

  if (page === "account") {
    return (
      <div {...stylex.props(styles.page)}>
        <Header back title="Account & security" lead="How you sign in, where you're signed in, and your account itself." />
        <Panel id="security">
          <Suspense fallback={<SectionSpinner />}>
            <SecuritySection />
          </Suspense>
        </Panel>
        <Panel id="linked-accounts">
          <Suspense fallback={<SectionSpinner />}>
            <LinkedAccountsSection />
          </Suspense>
        </Panel>
        <Panel id="active-sessions">
          <Suspense fallback={<SectionSpinner />}>
            <SessionsSection />
          </Suspense>
        </Panel>
        <Panel id="developer-api">
          <Suspense fallback={<SectionSpinner />}>
            <DeveloperApiSection />
          </Suspense>
        </Panel>
        <Panel id="danger-zone" danger>
          <DangerZoneSection />
        </Panel>
      </div>
    );
  }

  if (page === "billing") {
    return (
      <div {...stylex.props(styles.page)}>
        <Header back title="Plan & billing" lead="Your plan, its invoices, and the organization that pays for it." />
        <Panel id="plan-&-billing">
          <PlanSection
            plan={user.plan}
            subscriptionStatus={user.subscriptionStatus}
            hasManagedSubscription={user.hasManagedSubscription}
          />
        </Panel>
        <Panel id="organization">
          <OrganizationSection plan={user.plan} />
        </Panel>
      </div>
    );
  }

  return (
    <div {...stylex.props(styles.page, styles.wide)}>
      <Header title="Settings" lead="Changes save as you make them." />
      <div {...stylex.props(styles.layout)}>
      <nav aria-label="Settings sections" {...stylex.props(styles.toc)}>
        {TOC.map(([id, label]) => (
          <a key={id} href={`#settings-${id}`} {...stylex.props(styles.tocLink, motion.tint, focus.ring)}>
            {label}
          </a>
        ))}
        <span aria-hidden="true" {...stylex.props(styles.tocRule)} />
        <Link to="/settings" search={{ tab: "security" }} {...stylex.props(styles.tocLink, motion.tint, focus.ring)}>
          Account &amp; security
        </Link>
        <Link to="/settings" search={{ tab: "plan-&-billing" }} {...stylex.props(styles.tocLink, motion.tint, focus.ring)}>
          Plan &amp; billing
        </Link>
      </nav>
      <div {...stylex.props(styles.sections)}>
      <Panel id="profile">
        <ProfileSection user={user} />
      </Panel>
      <Panel id="appearance">
        <AppearanceSection appearance={user.appearance} />
      </Panel>
      <Panel id="meetings">
        <MeetingsSection />
      </Panel>
      <Panel id="privacy">
        <OrbSection user={user} />
      </Panel>
      <nav aria-label="More settings" {...stylex.props(styles.more)}>
        <Link to="/settings" search={{ tab: "security" }} {...stylex.props(styles.moreLink, motion.tint, focus.ring)}>
          <span {...stylex.props(styles.moreText)}>
            <span {...stylex.props(styles.moreTitle)}>Account &amp; security</span>
            <span {...stylex.props(styles.moreNote)}>
              Sign-in, linked accounts, signed-in devices, developer API, delete account.
            </span>
          </span>
          <ChevronRight size={18} aria-hidden="true" {...stylex.props(styles.chevron)} />
        </Link>
        <Link to="/settings" search={{ tab: "plan-&-billing" }} {...stylex.props(styles.moreLink, motion.tint, focus.ring)}>
          <span {...stylex.props(styles.moreText)}>
            <span {...stylex.props(styles.moreTitle)}>Plan &amp; billing</span>
            <span {...stylex.props(styles.moreNote)}>Your plan, invoices and organization.</span>
          </span>
          <ChevronRight size={18} aria-hidden="true" {...stylex.props(styles.chevron)} />
        </Link>
      </nav>
      </div>
      </div>
    </div>
  );
}

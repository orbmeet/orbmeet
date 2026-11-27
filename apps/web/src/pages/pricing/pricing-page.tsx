import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, X, Zap, Building2, Users, ChevronDown } from "lucide-react";
import { formatPlanDuration, getPlanLimits, type SubscriptionTier } from "@/modules/billing/contract/plan-limits";
import {
  openBillingPortal,
  startSubscriptionCheckout,
} from "@/modules/billing/client/billing-client";
import { sessionQueryOptions } from "@/modules/identity/client/session.queries";
import { planPricesQueryOptions } from "@/modules/billing/client/plan-prices.queries";
import { DEFAULT_PLAN_PRICES, formatPlanPrice, type PlanPrices } from "@/modules/billing/contract/plan-prices";
import { Button, buttonStyles } from "@orbmeet/ui/react";
import { enter, stagger } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion } from "@orbmeet/ui/styles/atoms";
import { accent, border, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { measure, space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { disclosure } from "@orbmeet/ui/tokens/markers.stylex";
import * as stylex from "@stylexjs/stylex";
import { PublicNav } from "@/app/shell/public-nav";
import { PublicFooter } from "@/app/shell/public-footer";
import { MAIN_CONTENT_ID } from "@/app/shell/skip-link";
import { logError } from "@/lib/logger";
import { PRICING_FAQS } from "@/lib/seo";
import { glass } from "@orbmeet/ui/tokens/wash.stylex";

interface PricingTier {
  id: SubscriptionTier;
  name: string;
  description: string;
  price: string;
  priceLabel: string;
  icon: React.ReactNode;
  popular?: boolean;
}

const TIERS: PricingTier[] = [
  {
    id: "free",
    name: "Free",
    description: "Meetings, Whiteboards, and AI Summaries for small groups — forever free",
    price: "$0",
    priceLabel: "Forever free",
    icon: <Users size={20} />,
  },
  {
    id: "pro",
    name: "Pro",
    description: "For professionals who need cloud recording, custom codes, and higher limits",
    price: "$5",
    priceLabel: "per month",
    icon: <Zap size={20} />,
    popular: true,
  },
  {
    id: "organization",
    name: "Organization",
    description: "For teams that need shared billing, member roles, and centrally billed Spaces",
    price: "$10",
    // A member of the Organization, not of a Space: each one is a paid seat.
    priceLabel: "per member / month",
    icon: <Building2 size={20} />,
  },
];

/** A tier priced in the visitor's checkout currency; Free shows zero in it too. */
function localizedTier(tier: PricingTier, prices: PlanPrices): PricingTier {
  if (tier.id === "free") return { ...tier, price: formatPlanPrice({ currency: prices.pro.currency, amount: 0 }) };
  const price = tier.id === "pro" ? prices.pro : prices.organizationSeat;
  return {
    ...tier,
    price: formatPlanPrice(price),
    priceLabel: prices.taxAddedAtCheckout ? `${tier.priceLabel} + tax` : tier.priceLabel,
  };
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Unlimited";
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb} GB`;
}

type NumericLimitKey =
  | "maxParticipants"
  | "maxConcurrentMeetings"
  | "maxSpaces"
  | "maxMembersPerSpace"
  | "maxWhiteboardRestorePointsPerBoard";

type BooleanLimitKey =
  | "recordingEnabled"
  | "streamingEnabled"
  | "pdfExportEnabled"
  | "aiFeaturesEnabled"
  | "customPersonalMeetingCode";

type FeatureRow =
  | { label: string; kind: "limit"; key: NumericLimitKey }
  | { label: string; kind: "duration" }
  | { label: string; kind: "storage" }
  | { label: string; kind: "text"; value: string | ((plan: SubscriptionTier) => string) }
  /** Yes/no rows render a readable sr-only label alongside the check/cross glyph. */
  | { label: string; kind: "boolean"; key?: BooleanLimitKey };

const checkStyles = stylex.create({
  mark: {
    display: "flex",
    height: 20,
    width: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.pill,
  },
  check: {
    backgroundColor: `color-mix(in oklab, ${accent.a500} 10%, transparent)`,
    color: accent.a600,
  },
  /**
   * The "no" was `neutral.n300` at 80% on `neutral.n100` — about 1.3:1, so at
   * a glance it read as a dimmed tick rather than as a cross, which is the one
   * misreading this column cannot afford.
   */
  cross: {
    backgroundColor: neutral.n100,
    color: ink.muted,
  },
});

function FeatureMark({ included }: { included: boolean }) {
  return (
    <span {...stylex.props(checkStyles.mark, included ? checkStyles.check : checkStyles.cross)}>
      {included ? <Check size={14} strokeWidth={3} /> : <X size={12} strokeWidth={3} />}
      <span {...stylex.props(layout.srOnly)}>{included ? "Included" : "Not included"}</span>
    </span>
  );
}

const FEATURES: FeatureRow[] = [
  { label: "Participants per meeting", kind: "limit", key: "maxParticipants" },
  { label: "Concurrent meetings", kind: "limit", key: "maxConcurrentMeetings" },
  { label: "Meeting duration", kind: "duration" },
  { label: "Spaces", kind: "limit", key: "maxSpaces" },
  { label: "Members per Space", kind: "limit", key: "maxMembersPerSpace" },
  { label: "Whiteboard restore points", kind: "limit", key: "maxWhiteboardRestorePointsPerBoard" },
  { label: "Organization members", kind: "text", value: (plan) => (plan === "organization" ? "Unlimited" : "—") },
  { label: "Storage", kind: "storage" },
  // Short, as every value in the column is: the row above is the allowance it counts toward.
  { label: "Meeting history", kind: "text", value: "No expiry" },
  { label: "Collaborative Whiteboard", kind: "boolean" },
  { label: "Cloud recording", kind: "boolean", key: "recordingEnabled" },
  { label: "Live streaming", kind: "boolean", key: "streamingEnabled" },
  { label: "Whiteboard PDF export", kind: "boolean", key: "pdfExportEnabled" },
  { label: "AI meeting summary", kind: "boolean", key: "aiFeaturesEnabled" },
  { label: "In-meeting Whiteboard AI", kind: "boolean", key: "aiFeaturesEnabled" },
  { label: "Permanent personal meeting link", kind: "boolean" },
  { label: "Custom personal codes", kind: "boolean", key: "customPersonalMeetingCode" },
];

function formatFeatureText(feature: Exclude<FeatureRow, { kind: "boolean" }>, plan: SubscriptionTier): string {
  const limits = getPlanLimits(plan);
  switch (feature.kind) {
    case "limit": {
      const value = limits[feature.key];
      return value === null ? "Unlimited" : value.toLocaleString("en-US");
    }
    case "duration":
      return formatPlanDuration(limits.maxMeetingDurationMinutes);
    case "storage":
      return formatBytes(limits.maxStorageBytes);
    case "text":
      return typeof feature.value === "function" ? feature.value(plan) : feature.value;
  }
}

const cardStyles = stylex.create({
  root: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    borderRadius: radii.panel,
    padding: { default: space.s6, [bp.sm]: space.s8 },
  },
  /** Highlighted (current or popular) cards sit on full white with more lift. */
  rootRaised: { backgroundColor: surface.raised, boxShadow: { default: shadows.elevated, [env.hoverable]: { default: shadows.elevated, ":hover": shadows.hover } } },
  rootPlain: {
    backgroundColor: glass.solid,
    boxShadow: { default: shadows.lift1, [env.hoverable]: { default: shadows.lift1, ":hover": shadows.hover } },
    transform: { default: "translateY(0)", [env.hoverable]: { default: "translateY(0)", ":hover": "translateY(-4px)" } },
  },

  /** The animated gradient rim, clipped one pixel outside the card. */
  rim: {
    position: "absolute",
    inset: -1,
    borderRadius: "inherit",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: 0,
  },
  rimCurrent: { backgroundColor: accent.a600 },
  rimPopular: { backgroundColor: accent.a500 },
  rimInner: {
    position: "absolute",
    inset: 2,
    borderRadius: "inherit",
    backgroundColor: surface.raised,
  },
  hairlineEdge: {
    position: "absolute",
    inset: 0,
    borderRadius: "inherit",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${border.base} 80%, transparent)`,
    pointerEvents: "none",
    zIndex: 0,
  },

  badgeDock: {
    position: "absolute",
    top: -14,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 1,
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    borderRadius: radii.pill,
    paddingInline: space.s4,
    paddingBlock: space.s1,
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: ink.onAccent,
  },
  /*
   * Both badges are 10px uppercase text on a gradient, so every stop has to
   * carry the label — not just the one the eye lands on. The old ramps ran out
   * to `a300` and `w200`, where white measured 1.95:1 and 1.25:1; the right
   * third of each badge was effectively blank.
   *
   * Blue can hold white if the ramp stays deep (a800→a600 keeps 5.22:1 at the
   * lightest stop). Amber cannot at any usable saturation, so the popular
   * badge takes dark amber ink instead of inverting — which is the
   * conventional treatment for a light-hue chip anyway.
   */
  badgeCurrent: {
    // The active-subscription rim was teal in the Tailwind build; the accent
    // blue keeps one accent on the page. — deliberate unification.
    backgroundColor: accent.a700,
  },
  badgePopular: { backgroundColor: accent.a600 },

  content: { position: "relative", zIndex: 1, display: "flex", flexDirection: "column", height: "100%" },
  head: {
    marginBottom: space.s4,
    display: "flex",
    alignItems: "center",
    gap: space.s3_5,
  },
  glyph: {
    display: "flex",
    height: 44,
    width: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.card,
  },
  glyphLit: {
    backgroundImage: `linear-gradient(to bottom right, ${accent.a50}, color-mix(in oklab, ${accent.a100} 50%, transparent))`,
    color: accent.a600,
    boxShadow: shadows.lift1,
  },
  glyphPlain: {
    backgroundImage: `linear-gradient(to bottom right, ${neutral.n50}, color-mix(in oklab, ${surface.sunken} 50%, transparent))`,
    // In the dark theme that gradient is a shade off the card; the ring is the tile's edge.
    boxShadow: `inset 0 0 0 1px ${neutral.n150}`,
    color: neutral.n600,
  },
  name: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: text.lg,
    fontWeight: weight.semibold,
    letterSpacing: "-0.02em",
    color: ink.strong,
  },
  description: {
    marginBottom: space.s4,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.muted,
  },
  priceRow: {
    marginBottom: space.s6,
    display: "flex",
    alignItems: "baseline",
    gap: space.s1,
  },
  price: {
    fontFamily: fonts.heading,
    fontSize: text.xl4,
    fontWeight: weight.extrabold,
    letterSpacing: tracking.tight,
    color: ink.strong,
  },
  priceLabel: { fontSize: text.sm, fontWeight: weight.medium, color: ink.muted },

  featureList: {
    margin: 0,
    marginBottom: space.s8,
    padding: 0,
    listStyleType: "none",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: neutral.n100,
    paddingTop: space.s5,
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },
  featureRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    fontSize: text.sm,
  },
  featureLabel: {
    fontWeight: weight.medium,
    color: { default: neutral.n600, [env.hoverable]: { default: neutral.n600, [stylex.when.ancestor(":hover")]: neutral.n800 } },
  },
  featureIcon: { transform: { default: "scale(1)", [env.hoverable]: { default: "scale(1)", [stylex.when.ancestor(":hover")]: "scale(1.1)" } } },
  featureValue: { fontWeight: weight.bold, color: ink.strong },

  actions: { marginTop: "auto", paddingTop: space.s4 },
  ctaFull: { width: "100%" },
  ctaError: {
    marginTop: space.s2,
    textAlign: "center",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: danger.d600,
  },
});

function PricingCard({
  tier,
  currentPlan,
  managesExistingSubscription,
  index,
}: {
  tier: PricingTier;
  currentPlan?: SubscriptionTier | null;
  managesExistingSubscription: boolean;
  index: number;
}) {
  const isCurrentPlan = currentPlan === tier.id;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pro is bought here. The Organization plan is bought for an Organization,
  // from its page in Settings.
  async function handleBillingAction() {
    if (tier.id !== "pro") return;
    setLoading(true);
    setError(null);
    try {
      if (managesExistingSubscription) await openBillingPortal();
      else await startSubscriptionCheckout({ plan: "pro" });
    } catch (err) {
      logError("[pricing] Checkout failed", err);
      setError("Something went wrong. Please try again or contact support.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      {...stylex.props(
        cardStyles.root,
        isCurrentPlan || tier.popular ? cardStyles.rootRaised : cardStyles.rootPlain,
        motion.move,
        enter.fadeUp,
        stagger.by(300 + index * 150),
      )}
    >
      {/* Animated gradient border for popular/current */}
      {(isCurrentPlan || tier.popular) && (
        <div
          {...stylex.props(
            cardStyles.rim,
            isCurrentPlan ? cardStyles.rimCurrent : cardStyles.rimPopular,
          )}
        >
          <div {...stylex.props(cardStyles.rimInner)} />
        </div>
      )}

      {/* Normal border for non-highlighted */}
      {!isCurrentPlan && !tier.popular && (
        <div {...stylex.props(cardStyles.hairlineEdge)} />
      )}

      {/* Badges */}
      {isCurrentPlan ? (
        <div {...stylex.props(cardStyles.badgeDock)}>
          <span {...stylex.props(cardStyles.badge, cardStyles.badgeCurrent)}>
            Your plan
          </span>
        </div>
      ) : tier.popular ? (
        <div {...stylex.props(cardStyles.badgeDock)}>
          <span {...stylex.props(cardStyles.badge, cardStyles.badgePopular)}>
            Most Popular
          </span>
        </div>
      ) : null}

      <div {...stylex.props(cardStyles.content)}>
        <div {...stylex.props(cardStyles.head)}>
          <div
            {...stylex.props(
              cardStyles.glyph,
              tier.popular ? cardStyles.glyphLit : cardStyles.glyphPlain,
              motion.move,
            )}
          >
            {tier.icon}
          </div>
          <div>
            <h3 {...stylex.props(cardStyles.name)}>{tier.name}</h3>
          </div>
        </div>

        <p {...stylex.props(cardStyles.description)}>{tier.description}</p>

        <div {...stylex.props(cardStyles.priceRow)}>
          <span {...stylex.props(cardStyles.price)}>{tier.price}</span>
          <span {...stylex.props(cardStyles.priceLabel)}>{tier.priceLabel}</span>
        </div>

        {/* A real list, so the plan's contents announce as a countable set
            rather than as eighteen loose lines of text. */}
        <ul aria-label={`What ${tier.name} includes`} {...stylex.props(cardStyles.featureList)}>
          {FEATURES.map((feature) => (
            <li key={feature.label} {...stylex.props(cardStyles.featureRow, stylex.defaultMarker())}>
              <span {...stylex.props(cardStyles.featureLabel, motion.tint)}>
                {feature.label}
              </span>
              {feature.kind === "boolean" ? (
                <span {...stylex.props(cardStyles.featureIcon, motion.move)}>
                  <FeatureMark included={feature.key ? getPlanLimits(tier.id)[feature.key] : true} />
                </span>
              ) : (
                <span {...stylex.props(cardStyles.featureValue)}>
                  {formatFeatureText(feature, tier.id)}
                </span>
              )}
            </li>
          ))}
        </ul>

        <div {...stylex.props(cardStyles.actions)}>
          {renderAction()}
        </div>
      </div>
    </div>
  );

  function renderAction() {
    if (!currentPlan) {
      return (
        <Link
          to="/auth"
          search={{ mode: "signup" }}
          {...stylex.props(...buttonStyles({ variant: tier.popular ? "primary" : "secondary", size: "lg", sx: cardStyles.ctaFull }))}
        >
          Get started
        </Link>
      );
    }

    if (tier.id === "pro" && (managesExistingSubscription || !isCurrentPlan)) {
      const label = managesExistingSubscription
        ? (loading ? "Opening..." : "Manage billing")
        : (loading ? "Loading..." : "Upgrade");
      return (
        <>
          <Button
            variant={managesExistingSubscription ? "secondary" : tier.popular ? "primary" : "secondary"}
            size="lg"
            sx={cardStyles.ctaFull}
            loading={loading}
            onClick={() => { void handleBillingAction(); }}
          >
            {label}
          </Button>
          {error && <p {...stylex.props(cardStyles.ctaError)}>{error}</p>}
        </>
      );
    }

    if (!isCurrentPlan && tier.id === "organization") {
      return (
        <Link
          to="/settings"
          search={{ tab: "plan-&-billing" }}
          {...stylex.props(...buttonStyles({ variant: "secondary", size: "lg", sx: cardStyles.ctaFull }))}
        >
          Set up an Organization
        </Link>
      );
    }

    return (
      <Link
        to="/home"
        {...stylex.props(...buttonStyles({ variant: "outline", size: "lg", sx: cardStyles.ctaFull }))}
      >
        Open Orb Meet
      </Link>
    );
  }
}

const faqStyles = stylex.create({
  grid: {
    display: "grid",
    gap: space.s3,
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.sm]: "repeat(2, minmax(0, 1fr))" },
    alignItems: "start",
  },
  item: {
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: {
      default: border.subtle,
      [env.hoverable]: { default: border.subtle, ":hover": border.strong },
    },
    borderRadius: radii.card,
    backgroundColor: surface.raised,
    transitionProperty: "border-color",
    transitionDuration: { default: "150ms", [env.reducedMotion]: "0s" },
  },
  trigger: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
    margin: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    paddingInline: space.s5,
    paddingBlock: space.s4,
    fontFamily: "inherit",
    textAlign: "start",
    cursor: "pointer",
    listStyleType: "none",
    // A real pseudo-element, just missing from the rule's allowlist. It is how
    // Safari's default disclosure triangle is removed from the <summary>.
    // oxlint-disable-next-line @stylexjs/valid-styles
    "::-webkit-details-marker": { display: "none" },
  },
  question: {
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    color: {
      default: ink.strong,
      [env.hoverable]: { default: ink.strong, [stylex.when.ancestor(":hover")]: accent.a700 },
    },
  },
  chevron: {
    height: 16,
    width: 16,
    flexShrink: 0,
    color: {
      default: neutral.n400,
      [env.hoverable]: { default: neutral.n400, [stylex.when.ancestor(":hover")]: accent.a600 },
      [stylex.when.ancestor(":is([open])", disclosure)]: accent.a600,
    },
    transform: {
      default: "rotate(0deg)",
      [stylex.when.ancestor(":is([open])", disclosure)]: "rotate(180deg)",
    },
  },
  answer: {
    margin: 0,
    paddingInline: space.s5,
    paddingBottom: space.s4,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.muted,
  },
});

function PricingFaqList({ faqs }: { faqs: Array<{ q: string; a: string }> }) {
  return (
    <div {...stylex.props(faqStyles.grid)}>
      {faqs.map(({ q, a }, index) => (
        <details
          key={q}
          {...stylex.props(faqStyles.item, enter.fadeUp, stagger.by(600 + index * 100), disclosure)}
        >
          <summary {...stylex.props(faqStyles.trigger, focus.ring, stylex.defaultMarker())}>
            <span {...stylex.props(faqStyles.question, motion.tint)}>{q}</span>
            <ChevronDown aria-hidden {...stylex.props(faqStyles.chevron, motion.move)} />
          </summary>
          <p {...stylex.props(faqStyles.answer)}>{a}</p>
        </details>
      ))}
    </div>
  );
}

const styles = stylex.create({
  page: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    minHeight: "100vh",
    // Unified with the app's canvas ground; the old neutral-50 was a one-off.
    backgroundColor: surface.canvas,
    overflow: "hidden",
    fontFamily: fonts.sans,
  },

  main: {
    position: "relative",
    zIndex: 1,
    marginInline: "auto",
    maxWidth: measure.page,
    width: "100%",
    paddingInline: { default: space.s4, [bp.sm]: space.s6 },
    paddingBottom: space.s16,
    paddingTop: { default: space.s12, [bp.sm]: space.s16 },
  },

  hero: { marginBottom: space.s10, textAlign: "center" },
  heroTitle: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: { default: "2.25rem", [bp.sm]: "3.25rem" },
    fontWeight: weight.semibold,
    letterSpacing: "-0.05em",
    lineHeight: 1.02,
    color: ink.strong,
  },
  heroLede: {
    marginInline: "auto",
    marginTop: space.s4,
    marginBottom: 0,
    maxWidth: "42rem",
    fontSize: text.lg,
    fontWeight: weight.medium,
    lineHeight: leading.relaxed,
    color: ink.muted,
  },


  cardGrid: {
    display: "grid",
    gap: space.s6,
    gridTemplateColumns: { default: "1fr", [bp.md]: "repeat(2, minmax(0, 1fr))", [bp.lg]: "repeat(3, minmax(0, 1fr))" },
    maxWidth: measure.page,
    marginInline: "auto",
  },

  currencyNote: {
    marginTop: space.s4,
    marginBottom: 0,
    textAlign: "center",
    fontSize: text.sm,
    color: ink.muted,
  },

  /** An open section, not a card: the questions are the bordered items. */
  faq: {
    marginTop: space.s16,
    width: "100%",
    maxWidth: measure.page,
    marginInline: "auto",
  },
  faqHead: { marginBottom: space.s8, textAlign: { default: "center", [bp.sm]: "start" } },
  faqTitle: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: { default: "1.75rem", [bp.sm]: "2.25rem" },
    fontWeight: weight.semibold,
    letterSpacing: "-0.045em",
    color: ink.strong,
  },
  faqLede: { marginTop: space.s1, marginBottom: 0, fontSize: text.sm, color: ink.muted },
});

export function PricingPage() {
  const { data: session } = useQuery(sessionQueryOptions());
  const currentPlan = session?.user?.plan;
  const managesExistingSubscription = session?.user?.hasManagedSubscription ?? false;

  const { data: prices = DEFAULT_PLAN_PRICES } = useQuery(planPricesQueryOptions());
  const tiers = TIERS.map((tier) => localizedTier(tier, prices));

  const faqs = PRICING_FAQS.map(({ question, answer }) => ({ q: question, a: answer }));

  return (
    <div {...stylex.props(styles.page)}>
      <PublicNav variant="marketing" />

      {/* Main content */}
      <main id={MAIN_CONTENT_ID} {...stylex.props(styles.main)}>
        {/* Hero */}
        <div {...stylex.props(styles.hero, enter.quantum)}>
          <h1 {...stylex.props(styles.heroTitle)}>Start free. Pay when you grow.</h1>
          <p
            {...stylex.props(styles.heroLede, enter.fadeUp, stagger.by(150))}
          >
            Every plan has the board, Orb, recaps and PDF export, and your own permanent meeting link. Paid plans lift the limits.
          </p>
        </div>

        {/* Pricing cards */}
        <div {...stylex.props(styles.cardGrid)}>
          {tiers.map((tier, i) => (
            <PricingCard
              key={tier.id}
              tier={tier}
              currentPlan={currentPlan}
              managesExistingSubscription={managesExistingSubscription}
              index={i}
            />
          ))}
        </div>
        <p {...stylex.props(styles.currencyNote)}>
          {prices.taxAddedAtCheckout
            ? "Prices in your checkout currency. Tax is added at checkout."
            : "Prices in your checkout currency, including any tax."}
        </p>

        {/* FAQ */}
        <section aria-labelledby="pricing-faq" {...stylex.props(styles.faq)}>
          <div {...stylex.props(styles.faqHead)}>
            <h2 id="pricing-faq" {...stylex.props(styles.faqTitle)}>
              Questions
            </h2>
            <p {...stylex.props(styles.faqLede)}>About plans, Organizations and what membership covers.</p>
          </div>
          <PricingFaqList faqs={faqs} />
        </section>

      </main>

      <PublicFooter />
    </div>
  );
}

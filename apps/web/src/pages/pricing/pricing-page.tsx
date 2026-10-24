import { ClientOnly, Link } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, X, Zap, Building2, Users, ChevronDown } from "lucide-react";
import { formatPlanDuration, getPlanLimits, type SubscriptionTier } from "@/modules/billing/contract/plan-limits";
import {
  openBillingPortal,
  startSubscriptionCheckout,
} from "@/modules/billing/client/billing-client";
import { sessionQueryOptions } from "@/app/query-client/queries/session";
import { enter, stagger } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
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
import { PRICING_FAQS } from "@/lib/seo";
import { faq } from "@/pages/pricing/components/pricing-faq-styles";
import { glass } from "@orbmeet/ui/tokens/wash.stylex";

const PricingFaqAccordion = lazy(async () => {
  const module = await import("@/pages/pricing/components/pricing-faq-accordion");
  return { default: module.PricingFaqAccordion };
});

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
    priceLabel: "per user / month",
    icon: <Zap size={20} />,
    popular: true,
  },
  {
    id: "organization",
    name: "Organization",
    description: "For teams that need shared billing, member roles, and centrally billed Spaces",
    price: "$10",
    // "per member" contradicted the page's own FAQ and the Terms, both of
    // which turn on a license *not* being Space membership.
    priceLabel: "per licensed user / month",
    icon: <Building2 size={20} />,
  },
];

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Unlimited";
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb} GB`;
}

interface FeatureRow {
  label: string;
  getValue: (plan: SubscriptionTier) => React.ReactNode;
  /**
   * Present on the rows that are a yes/no rather than a number. Returns the
   * answer, not a glyph: a tick and a cross are the same element to a screen
   * reader unless something says which is which, and for a while nothing did
   * — all three plans read out an identical list of feature names.
   */
  getIncluded?: (plan: SubscriptionTier) => boolean;
}

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

/**
 * A single yes/no cell. The glyph is decoration over a word, rather than the
 * only thing carrying the answer.
 */
function FeatureMark({ included }: { included: boolean }) {
  return (
    <span {...stylex.props(checkStyles.mark, included ? checkStyles.check : checkStyles.cross)}>
      {included ? <Check size={14} strokeWidth={3} /> : <X size={12} strokeWidth={3} />}
      <span {...stylex.props(layout.srOnly)}>{included ? "Included" : "Not included"}</span>
    </span>
  );
}

const FEATURES: FeatureRow[] = [
  {
    label: "Participants per meeting",
    getValue: (plan) => {
      const val = getPlanLimits(plan).maxParticipants;
      return val === null ? "Unlimited" : val;
    },
  },
  {
    label: "Concurrent meetings",
    getValue: (plan) => {
      const val = getPlanLimits(plan).maxConcurrentMeetings;
      return val === null ? "Unlimited" : val;
    },
  },
  {
    label: "Meeting duration",
    getValue: (plan) => formatPlanDuration(getPlanLimits(plan).maxMeetingDurationMinutes),
  },
  {
    label: "Spaces",
    getValue: (plan) => {
      const val = getPlanLimits(plan).maxSpaces;
      return val === null ? "Unlimited" : val;
    },
  },
  {
    label: "Members per Space",
    getValue: (plan) => {
      const val = getPlanLimits(plan).maxMembersPerSpace;
      return val === null ? "Unlimited" : val;
    },
  },
  {
    label: "Active Whiteboards per Space",
    getValue: (plan) => getPlanLimits(plan).maxWhiteboardsPerSpace,
  },
  {
    label: "Whiteboard restore points",
    getValue: (plan) => getPlanLimits(plan).maxWhiteboardRestorePointsPerBoard,
  },
  {
    label: "Organization licenses",
    getValue: (plan) => plan === "organization" ? 25 : "—",
  },
  {
    label: "Storage",
    getValue: (plan) => formatBytes(getPlanLimits(plan).maxStorageBytes),
  },
  {
    label: "Meeting history",
    // Short, as every value in the column is: the row above is the allowance it counts toward.
    getValue: () => "No expiry",
  },
  {
    label: "Collaborative Whiteboard",
    getIncluded: () => true,
    getValue: () => null,
  },
  {
    label: "Cloud recording",
    getIncluded: (plan) => getPlanLimits(plan).recordingEnabled,
    getValue: () => null,
  },
  {
    label: "Live streaming",
    getIncluded: (plan) => getPlanLimits(plan).streamingEnabled,
    getValue: () => null,
  },
  {
    label: "Whiteboard PDF export",
    getIncluded: (plan) => getPlanLimits(plan).pdfExportEnabled,
    getValue: () => null,
  },
  {
    label: "AI meeting summary",
    getIncluded: (plan) => getPlanLimits(plan).aiFeaturesEnabled,
    getValue: () => null,
  },
  {
    label: "In-meeting Whiteboard AI",
    getIncluded: (plan) => getPlanLimits(plan).aiFeaturesEnabled,
    getValue: () => null,
  },
  {
    label: "Permanent personal meeting link",
    getIncluded: () => true,
    getValue: () => null,
  },
  {
    label: "Custom personal codes",
    getIncluded: (plan) => getPlanLimits(plan).customPersonalMeetingCode,
    getValue: () => null,
  },
];

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

  /** The plan CTAs. All of them press in slightly and recover. */
  cta: {
    display: "inline-flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
    paddingBlock: space.s3,
    fontSize: text.sm,
    fontWeight: weight.bold,
    transform: {
      default: "scale(1)",
      [env.hoverable]: { default: "scale(1)", ":hover:not(:disabled)": "scale(1.02)" },
      ":active:not(:disabled)": "scale(0.98)",
    },
    opacity: { default: 1, ":disabled": 0.6 },
  },
  /**
   * One primary per screen: the recommended tier's button is the blue one,
   * every other tier's is secondary. There is no dark button in the system.
   */
  ctaSecondary: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n200, [env.hoverable]: { default: neutral.n200, ":hover:not(:disabled)": neutral.n300 } },
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover:not(:disabled)": neutral.n50 } },
    color: ink.strong,
    boxShadow: shadows.hairline,
  },
  ctaPrimary: {
    backgroundColor: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover:not(:disabled)": accent.a800 } },
    color: ink.onAccent,
    boxShadow: shadows.lift1,
  },
  ctaSoft: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${accent.a200} 50%, transparent)`,
    backgroundImage: `linear-gradient(to right, ${accent.a50}, color-mix(in oklab, ${accent.a100} 50%, transparent))`,
    color: accent.a700,
    boxShadow: shadows.lift1,
  },
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

  async function handleBillingAction() {
    if (tier.id === "free") return;
    setLoading(true);
    setError(null);
    try {
      if (managesExistingSubscription) await openBillingPortal();
      else await startSubscriptionCheckout(tier.id);
    } catch (err) {
      console.error("Checkout failed:", err);
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
            Active Subscription
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
              {feature.getIncluded ? (
                <span {...stylex.props(cardStyles.featureIcon, motion.move)}>
                  <FeatureMark included={feature.getIncluded(tier.id)} />
                </span>
              ) : (
                <span {...stylex.props(cardStyles.featureValue)}>{feature.getValue(tier.id)}</span>
              )}
            </li>
          ))}
        </ul>

        <div {...stylex.props(cardStyles.actions)}>
          {managesExistingSubscription && tier.id !== "free" ? (
            <>
              <button
                onClick={() => {
                  void handleBillingAction();
                }}
                disabled={loading}
                {...stylex.props(
                  pressable.base,
                  focus.ring,
                  cardStyles.cta,
                  cardStyles.ctaSecondary,
                  motion.move,
                )}
              >
                {loading ? "Opening..." : "Manage billing"}
              </button>
              {error && (
                <p {...stylex.props(cardStyles.ctaError)}>{error}</p>
              )}
            </>
          ) : isCurrentPlan ? (
            <Link
              to="/home"
              {...stylex.props(pressable.base, focus.ring, cardStyles.cta, cardStyles.ctaSoft, motion.move)}
            >
              Go home
            </Link>
          ) : currentPlan && tier.id !== "free" ? (
            <>
              <button
                onClick={() => {
                  void handleBillingAction();
                }}
                disabled={loading}
                {...stylex.props(
                  pressable.base,
                  focus.ring,
                  cardStyles.cta,
                  tier.popular ? cardStyles.ctaPrimary : cardStyles.ctaSecondary,
                  motion.move,
                )}
              >
                {loading ? "Loading..." : "Upgrade"}
              </button>
              {error && (
                <p {...stylex.props(cardStyles.ctaError)}>{error}</p>
              )}
            </>
          ) : (
            <Link
              to="/auth"
              search={{ mode: "signup" }}
              {...stylex.props(
                pressable.base,
                focus.ring,
                cardStyles.cta,
                tier.popular ? cardStyles.ctaPrimary : cardStyles.ctaSecondary,
                motion.move,
              )}
            >
              Get started
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function PricingFaqFallback({ faqs }: { faqs: Array<{ q: string; a: string }> }) {
  return (
    <div {...stylex.props(faq.grid)}>
      {faqs.map(({ q, a }, index) => (
        <details
          key={q}
          {...stylex.props(faq.item, enter.fadeUp, stagger.by(600 + index * 100), disclosure)}
        >
          <summary {...stylex.props(faq.trigger, focus.ring, stylex.defaultMarker())}>
            <span {...stylex.props(faq.question, motion.tint)}>{q}</span>
            <ChevronDown aria-hidden {...stylex.props(faq.chevron, motion.move)} />
          </summary>
          <p {...stylex.props(faq.answer)}>{a}</p>
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
          {TIERS.map((tier, i) => (
            <PricingCard
              key={tier.id}
              tier={tier}
              currentPlan={currentPlan}
              managesExistingSubscription={managesExistingSubscription}
              index={i}
            />
          ))}
        </div>

        {/* FAQ */}
        <section aria-labelledby="pricing-faq" {...stylex.props(styles.faq)}>
          <div {...stylex.props(styles.faqHead)}>
            <h2 id="pricing-faq" {...stylex.props(styles.faqTitle)}>
              Questions
            </h2>
            <p {...stylex.props(styles.faqLede)}>About plans, organizations and what a license covers.</p>
          </div>
          <ClientOnly fallback={<PricingFaqFallback faqs={faqs} />}>
            <Suspense fallback={<PricingFaqFallback faqs={faqs} />}>
              <PricingFaqAccordion faqs={faqs} />
            </Suspense>
          </ClientOnly>
        </section>

      </main>

      <PublicFooter />
    </div>
  );
}

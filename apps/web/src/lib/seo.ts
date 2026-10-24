export const SITE_NAME = "Orb Meet";
export const SITE_URL = "https://orbmeet.com";
const SUPPORT_EMAIL = "support@orbmeet.com";
const SITE_LOGO_URL = `${SITE_URL}/favicon.svg`;
export const SITE_DESCRIPTION =
  "Open-source visual meeting workspace for recurring groups, with durable Whiteboards, live facilitation, transcripts, and retained Meeting outputs.";
export const DEFAULT_ROBOTS =
  "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1";

const ORGANIZATION_ID = `${SITE_URL}/#organization`;
const WEBSITE_ID = `${SITE_URL}/#website`;
const SOFTWARE_ID = `${SITE_URL}/#software`;

const PRODUCT_FEATURES = [
  "Browser-based video meetings",
  "Durable collaborative Whiteboards",
  "Personal meeting links and Space invite flows",
  "Live captions and transcripts",
  "Meeting summaries and artifacts",
  "Spaces, members, and access control",
  "Self-hosted realtime infrastructure",
] as const;

const PUBLIC_PAGES = [
  {
    name: "Home",
    path: "/",
    description:
      "Product overview for meeting, writing together on durable Whiteboards, and preserving the work afterward.",
  },
  {
    name: "Pricing",
    path: "/pricing",
    description:
      "Free, Pro, and Organization plans for Orb Meet with feature and usage limits.",
  },
  {
    name: "Status",
    path: "/status",
    description:
      "Current service status for Orb Meet infrastructure and meeting systems.",
  },
  {
    name: "Privacy Policy",
    path: "/privacy",
    description:
      "Privacy and data handling policy for Orb Meet accounts, meetings, and artifacts.",
  },
  {
    name: "Terms of Service",
    path: "/terms",
    description: "Terms governing use of Orb Meet.",
  },
  {
    name: "Refund Policy",
    path: "/refund",
    description: "Refund and cancellation terms for Orb Meet subscriptions.",
  },
] as const;

export const PRICING_FAQS = [
  {
    question: "How does Organization billing work?",
    answer:
      "Organization costs $10 per licensed user each month. A license permits assignment to Organization-funded Spaces; it does not grant access to every Space.",
  },
  {
    question: "Who needs an Organization license?",
    answer:
      "Every owner, administrator, or user assigned to an Organization-funded Space needs a license.",
  },
  {
    question: "Does a license grant content access?",
    answer:
      "No. Direct Space membership separately controls Meetings, Whiteboards, Files, and history.",
  },
  {
    question: "Can I manage my subscription?",
    answer:
      "Yes. Active subscribers can open the Paddle billing portal from Settings to manage or cancel their subscription.",
  },
] as const;

const PLAN_SUMMARIES = [
  {
    id: "free",
    name: "Free",
    priceUsdMonthly: 0,
    billingUnit: "free",
    summary: "For Meetings, one permanent personal meeting link, and one Space.",
  },
  {
    id: "pro",
    name: "Pro",
    priceUsdMonthly: 5,
    billingUnit: "user",
    summary: "For cloud recording, a custom Meeting code, and higher usage limits.",
  },
  {
    id: "organization",
    name: "Organization",
    priceUsdMonthly: 10,
    billingUnit: "member",
    summary: "For organizations that manage people and Spaces.",
  },
] as const;

type MetaTag = Record<string, string>;
type LinkTag = Record<string, string>;
type ScriptTag = {
  type: string;
  children: string;
};

type PageHeadOptions = {
  title: string;
  description: string;
  path?: string;
  ogType?: string;
  noindex?: boolean;
  robots?: string;
  canonical?: boolean;
  extraMeta?: MetaTag[];
  extraLinks?: LinkTag[];
  scripts?: ScriptTag[];
};

export function absoluteUrl(path = "/"): string {
  if (/^https?:\/\//.test(path)) return path;
  return new URL(path, SITE_URL).toString();
}

export function createJsonLdScript(data: unknown): ScriptTag {
  return {
    type: "application/ld+json",
    children: JSON.stringify(data),
  };
}

export function createPageHead({
  title,
  description,
  path,
  ogType = "website",
  noindex = false,
  robots,
  canonical = true,
  extraMeta = [],
  extraLinks = [],
  scripts = [],
}: PageHeadOptions) {
  const url = path ? absoluteUrl(path) : undefined;
  const resolvedRobots = noindex
    ? "noindex, nofollow, noarchive"
    : (robots ?? DEFAULT_ROBOTS);

  return {
    meta: [
      { title },
      { name: "description", content: description },
      { name: "robots", content: resolvedRobots },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      ...(url ? [{ property: "og:url", content: url }] : []),
      { property: "og:type", content: ogType },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      ...extraMeta,
    ],
    links: [
      ...(canonical && url ? [{ rel: "canonical", href: url }] : []),
      ...extraLinks,
    ],
    scripts,
  };
}

export function buildSiteGraph() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": ORGANIZATION_ID,
        name: SITE_NAME,
        url: SITE_URL,
        logo: SITE_LOGO_URL,
        email: SUPPORT_EMAIL,
        contactPoint: [
          {
            "@type": "ContactPoint",
            contactType: "customer support",
            email: SUPPORT_EMAIL,
            url: SITE_URL,
          },
        ],
      },
      {
        "@type": "WebSite",
        "@id": WEBSITE_ID,
        url: SITE_URL,
        name: SITE_NAME,
        description: SITE_DESCRIPTION,
        inLanguage: "en",
        publisher: {
          "@id": ORGANIZATION_ID,
        },
      },
      {
        "@type": "SoftwareApplication",
        "@id": SOFTWARE_ID,
        name: SITE_NAME,
        url: SITE_URL,
        description: SITE_DESCRIPTION,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web Browser",
        isAccessibleForFree: true,
        provider: {
          "@id": ORGANIZATION_ID,
        },
        featureList: [...PRODUCT_FEATURES],
      },
    ],
  };
}

export function buildWebPageGraph({
  title,
  description,
  path,
  type = "WebPage",
}: {
  title: string;
  description: string;
  path: string;
  type?: string;
}) {
  const pageUrl = absoluteUrl(path);
  return {
    "@context": "https://schema.org",
    "@type": type,
    "@id": `${pageUrl}#webpage`,
    url: pageUrl,
    name: title,
    description,
    isPartOf: {
      "@id": WEBSITE_ID,
    },
    about: {
      "@id": SOFTWARE_ID,
    },
    inLanguage: "en",
  };
}

export function buildPricingGraph() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      buildWebPageGraph({
        title: "Pricing — Orb Meet",
        description:
          "Simple, transparent pricing for Orb Meet video meetings and collaborative Whiteboards.",
        path: "/pricing",
        type: "CollectionPage",
      }),
      {
        "@type": "SoftwareApplication",
        "@id": `${absoluteUrl("/pricing")}#pricing-software`,
        name: SITE_NAME,
        url: SITE_URL,
        description: SITE_DESCRIPTION,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web Browser",
        provider: {
          "@id": ORGANIZATION_ID,
        },
        offers: PLAN_SUMMARIES.map((plan) => ({
          "@type": "Offer",
          name: `${SITE_NAME} ${plan.name}`,
          price: plan.priceUsdMonthly,
          priceCurrency: "USD",
          availability: "https://schema.org/InStock",
          description: plan.summary,
          url: absoluteUrl("/pricing"),
        })),
      },
      {
        "@type": "FAQPage",
        "@id": `${absoluteUrl("/pricing")}#faq`,
        mainEntity: PRICING_FAQS.map((faq) => ({
          "@type": "Question",
          name: faq.question,
          acceptedAnswer: {
            "@type": "Answer",
            text: faq.answer,
          },
        })),
      },
    ],
  };
}

export function buildLlmsTxt(): string {
  const lines = [
    `# ${SITE_NAME}`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    "## Product",
    ...PRODUCT_FEATURES.map((feature) => `- ${feature}`),
    "",
    "## Plans",
    ...PLAN_SUMMARIES.map(
      (plan) =>
        `- ${plan.name}: ${plan.priceUsdMonthly === 0 ? "Free" : `$${plan.priceUsdMonthly}/${plan.billingUnit}/month`} — ${plan.summary}`,
    ),
    "",
    "## Important Pages",
    ...PUBLIC_PAGES.map((page) => `- [${page.name}](${absoluteUrl(page.path)}) — ${page.description}`),
    "",
    "## Machine-readable Endpoints",
    `- [LLMs instructions](${absoluteUrl("/llms.txt")})`,
    `- [AI discovery JSON](${absoluteUrl("/api/llms.json")})`,
    `- [Sitemap](${absoluteUrl("/sitemap.xml")})`,
    "",
    "## Contact",
    `- [Website](${SITE_URL})`,
    `- [Support](mailto:${SUPPORT_EMAIL})`,
    "",
  ];

  return lines.join("\n");
}

export function buildAiDiscoveryDocument() {
  return {
    version: 1,
    site: {
      name: SITE_NAME,
      url: SITE_URL,
      description: SITE_DESCRIPTION,
      logoUrl: SITE_LOGO_URL,
      supportEmail: SUPPORT_EMAIL,
    },
    product: {
      name: SITE_NAME,
      category: "Browser-based meeting platform",
      features: [...PRODUCT_FEATURES],
      plans: PLAN_SUMMARIES.map((plan) => ({ ...plan })),
    },
    pages: PUBLIC_PAGES.map((page) => ({
      ...page,
      url: absoluteUrl(page.path),
    })),
    machineReadableEndpoints: {
      llmsTxt: absoluteUrl("/llms.txt"),
      sitemap: absoluteUrl("/sitemap.xml"),
    },
    schema: buildSiteGraph(),
  };
}

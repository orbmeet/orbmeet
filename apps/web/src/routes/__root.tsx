import {
  createRootRouteWithContext,
  Outlet,
  HeadContent,
  Link,
  Scripts,
  useRouter,
} from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { buttonStyles } from "@orbmeet/ui/react";
import { row } from "@orbmeet/ui/styles/atoms";
import { danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { measure, space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import "@/styles.css";
import { lazy, Suspense, useEffect, useState } from "react";
import { PwaStatus } from "@/app/shell/pwa-status";
import { DeadEnd } from "@/app/shell/dead-end";
import { BillingCheckoutSync } from "@/modules/billing/client/billing-checkout-sync";
import {
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
  createJsonLdScript,
  buildSiteGraph,
} from "@/lib/seo";
import { startDevStyleXRuntime } from "@/lib/dev-stylex-runtime";
import { formatErrorDiagnostics } from "@/lib/error-inspection";
import {
  installClientErrorReporting,
  reportBoundaryError,
  setClientErrorRoute,
} from "@/lib/telemetry/client-errors";
import { installTelemetryOutbox } from "@/lib/telemetry/outbox";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { resolveCspNonce } from "@/platform/http/csp-nonce";
import { APPEARANCE_SCRIPT, THEME_COLOR, applyThemeColor, readAppearance } from "@/app/appearance/appearance";
import { IN_APP_BROWSER_SCRIPT } from "@/app/shell/in-app-browser";

const styles = stylex.create({
  errorPage: {
    display: "flex",
    minHeight: "100vh",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: neutral.n50,
    paddingInline: space.s6,
  },
  centered: { textAlign: "center" },
  errorTitle: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: text.xl2,
    lineHeight: leading.xl2,
    fontWeight: weight.bold,
    color: ink.strong,
  },
  errorCopy: {
    marginTop: space.s2,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  errorDetails: {
    marginInline: "auto",
    marginTop: space.s3,
    maxWidth: measure.panel,
    overflow: "auto",
    borderRadius: radii.field,
    backgroundColor: danger.d50,
    padding: space.s3,
    textAlign: "start",
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: danger.d800,
  },
  actions: { marginTop: space.s6, justifyContent: "center" },
  document: { minHeight: "100%" },
  body: {
    minHeight: "100%",
    margin: 0,
    backgroundColor: surface.canvas,
    color: ink.strong,
    fontFamily: fonts.sans,
    WebkitFontSmoothing: "antialiased",
    MozOsxFontSmoothing: "grayscale",
    isolation: "isolate",
  },
});

const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import("@tanstack/react-query-devtools").then((m) => ({
        default: m.ReactQueryDevtools,
      }))
    )
  : null;

const TanStackRouterDevtools = import.meta.env.DEV
  ? lazy(() =>
      import("@tanstack/react-router-devtools").then((m) => ({
        default: m.TanStackRouterDevtools,
      }))
    )
  : null;

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      // viewport-fit=cover makes env(safe-area-inset-*) non-zero on notched
      // iOS devices; the meeting layout and whiteboard chrome depend on it.
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      { title: `${SITE_NAME} — Visual Meeting Workspace` },
      {
        name: "description",
        content: SITE_DESCRIPTION,
      },
      { name: "application-name", content: SITE_NAME },
      { name: "apple-mobile-web-app-title", content: SITE_NAME },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "theme-color", media: "(prefers-color-scheme: light)", content: THEME_COLOR.light },
      { name: "theme-color", media: "(prefers-color-scheme: dark)", content: THEME_COLOR.dark },
      { name: "referrer", content: "strict-origin-when-cross-origin" },
      {
        name: "robots",
        content: "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1",
      },
      { property: "og:site_name", content: SITE_NAME },
      { property: "og:type", content: "website" },
      { property: "og:locale", content: "en_US" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [
      ...(__STYLEX_DEV__
        ? [{ rel: "stylesheet", href: "/virtual:stylex.css" }]
        : []),
      { rel: "icon", href: "/favicon.svg" },
      // iOS ignores manifest icons; without this the home-screen icon for
      // "Add to Home Screen" installs is a screenshot of the page.
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.json" },
      {
        rel: "alternate",
        type: "text/plain",
        title: "LLMs",
        href: `${SITE_URL}/llms.txt`,
      },
      {
        rel: "alternate",
        type: "application/json",
        title: "AI Discovery",
        href: `${SITE_URL}/api/llms.json`,
      },
    ],
    scripts: [createJsonLdScript(buildSiteGraph())],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
  notFoundComponent: NotFoundPage,
  errorComponent: RootErrorComponent,
});

function RootErrorComponent({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();
  const isOffline = typeof navigator !== "undefined" && !navigator.onLine;
  const diagnostics = import.meta.env.DEV ? formatErrorDiagnostics(error) : undefined;

  useEffect(() => {
    queryErrorResetBoundary.reset();
  }, [queryErrorResetBoundary]);

  useEffect(() => {
    reportBoundaryError("root", error);
  }, [error]);

  return (
    <div {...stylex.props(styles.errorPage)}>
      <div {...stylex.props(styles.centered)}>
        <h1 {...stylex.props(styles.errorTitle)}>
          Something went wrong
        </h1>
        <p {...stylex.props(styles.errorCopy)}>
          {isOffline
            ? "You’re offline. Reconnect to continue using meetings and live collaboration."
            : "An unexpected error occurred. Please try again."}
        </p>
        {diagnostics && (
          <pre {...stylex.props(styles.errorDetails)}>{diagnostics}</pre>
        )}
        <div {...stylex.props(row.x3, styles.actions)}>
          <button
            onClick={() => {
              queryErrorResetBoundary.reset();
              reset();
              void router.invalidate();
            }}
            {...stylex.props(...buttonStyles())}
          >
            Retry
          </button>
          <Link
            to="/"
            {...stylex.props(...buttonStyles({ variant: "secondary" }))}
          >
            Go back home
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * `/$code` is a catch-all, so every unknown URL in the app arrives here —
 * including a meeting code mistyped badly enough to lose its shape, which is
 * why the copy names that possibility instead of stopping at "not found".
 */
function NotFoundPage() {
  return (
    <DeadEnd
      eyebrow="404"
      title="We couldn’t find that page"
      body="The link may be out of date, or a meeting code may have been mistyped. Meeting codes look like abc-defg-hij."
      documentTitle={`Page not found — ${SITE_NAME}`}
      secondaryAction={{ to: "/pricing", label: "See what’s included" }}
    />
  );
}

/**
 * TanStack Start renders the document from React instead of Vite's index.html,
 * so StyleX's transformIndexHtml hook cannot attach its development sheet or
 * HMR runtime. Production CSS is still collected into the root CSS asset by
 * cssInjectionTarget in vite.config.ts.
 */
function DevStyleXRuntime() {
  useEffect(() => {
    if (!__STYLEX_DEV__) return;
    startDevStyleXRuntime();
  }, []);

  return null;
}

/** The faces that render above the fold on a first paint. */
const FONT_PRELOADS = [
  "/fonts/geist-latin.woff2",
  "/fonts/geist-mono-latin.woff2",
] as const;

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" {...stylex.props(styles.document)} suppressHydrationWarning>
      {/*
        No React Refresh preamble here: TanStack Start injects it into its dev
        client entry (start-plugin-core's createDevClientEntryPlugin) whenever
        the client environment is served with HMR on. A second copy in <head>
        would re-run injectIntoGlobalHook and re-stub $RefreshReg$/$RefreshSig$.
      */}
      <head>
        {/*
          Font preloads, before <HeadContent /> so they are the first thing the
          parser sees: `@font-face` is otherwise only discovered once the
          stylesheet has been fetched and parsed, which put the text's face
          ~1.9s into the load and shifted the header when it swapped in.

          They live here rather than in the route's `head()` because React's
          resource float pass rewrites hoisted <link> tags and dropped these
          from the prerendered HTML. One file per face: each variable face
          carries every weight, and the extended-Latin files load only when a
          page needs them. Geist Mono is here because codes and clocks are
          read on first paint, the meeting's above all.

          `crossOrigin` is required even though these are same-origin: fonts
          are always fetched in CORS mode, and a preload without it is
          discarded and refetched.
        */}
        {/*
          Sets the viewer's light or dark choice on <html> before the body is
          parsed, so the first paint is already in the right theme. First in
          <head>: nothing above it may paint.
        */}
        <script nonce={resolveCspNonce()} dangerouslySetInnerHTML={{ __html: APPEARANCE_SCRIPT }} suppressHydrationWarning />
        {/*
          Another app's built-in browser stops here, before any of the app's
          scripts are parsed, and is sent to a page that hands the link to the
          real browser (app/shell/in-app-browser.ts).
        */}
        <script nonce={resolveCspNonce()} dangerouslySetInnerHTML={{ __html: IN_APP_BROWSER_SCRIPT }} suppressHydrationWarning />
        {FONT_PRELOADS.map((href) => (
          <link key={href} rel="preload" as="font" type="font/woff2" href={href} crossOrigin="anonymous" />
        ))}
        <HeadContent />
      </head>
      <body {...stylex.props(styles.body)} suppressHydrationWarning>
        {/*
          Base UI injects elements of its own — a `<style>` from `Select.Popup`,
          a pre-hydration `<script>` from `Tabs.Indicator` — and `CSPProvider`
          is the only way to get the document nonce onto them. Without it they
          are admitted purely by the `'unsafe-inline'` that `style-src` still
          carries for tldraw's print stylesheet, which is the one thing left
          standing between this app and a nonce-only style policy.

          It sits in the shell rather than in `RootComponent` because context
          has to be above every consumer, and `csp-provider` is exempted from
          `ssrClientStubs` for the same reason: the Base UI stub renders null
          and swallows its children.
        */}
        <CSPProvider nonce={resolveCspNonce()}>{children}</CSPProvider>
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  // The devtools are browser-only, but deciding that with `typeof window`
  // during render is the mismatch React warns about first: the hydrating client
  // render emitted two `Suspense` nodes the SSR HTML never had, so React threw
  // the whole root tree away and re-rendered it on every dev page load. Mount
  // them from an effect instead — the hydrating render then matches the server
  // exactly, and the devtools appear on the commit right after.
  const [showDevtools, setShowDevtools] = useState(false);
  useEffect(() => {
    if (import.meta.env.DEV) setShowDevtools(true);
  }, []);

  // The browser chrome takes the viewer's light or dark choice on every page,
  // signed in or not; the page itself already has it from the head script.
  useEffect(() => {
    applyThemeColor(readAppearance());
  }, []);

  // Errors the page meets, and the reports it could not send before.
  const router = useRouter();
  useEffect(() => {
    setClientErrorRoute(() => router.state.matches.at(-1)?.routeId);
    const uninstallOutbox = installTelemetryOutbox();
    const uninstallErrorReporting = installClientErrorReporting();
    return () => {
      uninstallErrorReporting();
      uninstallOutbox();
    };
  }, [router]);

  return (
    <>
      <Outlet />
      <DevStyleXRuntime />
      <PwaStatus />
      <BillingCheckoutSync />
      {showDevtools && ReactQueryDevtools && (
        <Suspense fallback={null}>
          {/* `top-left`, not `bottom-left`: the app's own Settings link and
              account avatar sit in the bottom-left of the sidebar, and the
              floating toggle landed exactly on top of them — the Settings
              link failed hit-testing in dev. */}
          <ReactQueryDevtools buttonPosition="top-left" />
        </Suspense>
      )}
      {showDevtools && TanStackRouterDevtools && (
        <Suspense fallback={null}>
          <TanStackRouterDevtools position="bottom-right" />
        </Suspense>
      )}
    </>
  );
}

/**
 * Which browsers OrbMeet runs on.
 *
 * Nobody picks a version here. The floor is whatever the code needs: each
 * platform feature the app uses without a fallback is listed with the first
 * release of every engine that ships it, and the oldest supported browser is
 * the newest of those per engine. Adopting a newer feature means adding it
 * here, which raises the floor; dropping one may lower it.
 *
 * Three things follow from the list, so they can never disagree:
 * - the JavaScript build target (apps/web/build/config/environments.ts);
 * - the CSS target StyleX hands to Lightning CSS (stylex.config.ts);
 * - `UNSUPPORTED_BROWSER_SCRIPT`, which turns away a browser below the floor
 *   by testing for the features themselves, never by reading a user agent.
 *
 * Like the other head scripts this module is plain data: the build config
 * imports it, so it may import nothing.
 */

type Engine = "chrome" | "edge" | "firefox" | "safari";
type Version = readonly [major: number, minor?: number];

interface RequiredFeature {
  /** What needs it. */
  why: string;
  /** A JavaScript expression, true where the feature is native. */
  test: string;
  /** The first release of each engine with the feature. */
  since: Record<Engine, Version>;
}

const REQUIRED_FEATURES: readonly RequiredFeature[] = [
  {
    // Lightning CSS can polyfill it, but the polyfill resolves each token
    // where it is declared, at the root, so a subtree that pins its own
    // `color-scheme` (the board) would still get the page's colours.
    why: "CSS light-dark(): every StyleX colour token",
    test: `CSS.supports("color","light-dark(#000,#fff)")`,
    since: { chrome: [123], edge: [123], firefox: [120], safari: [17, 5] },
  },
  {
    why: "AbortSignal.any(): requests bounded by both a timeout and a teardown",
    test: `typeof AbortSignal.any==="function"`,
    since: { chrome: [116], edge: [116], firefox: [124], safari: [17, 4] },
  },
];

function newer(a: Version, b: Version): Version {
  return a[0] !== b[0] ? (a[0] > b[0] ? a : b) : (a[1] ?? 0) >= (b[1] ?? 0) ? a : b;
}

function floorOf(engine: Engine): Version {
  return REQUIRED_FEATURES.map((feature) => feature.since[engine]).reduce(newer);
}

const ENGINES: readonly Engine[] = ["chrome", "edge", "firefox", "safari"];

/** The oldest release of each engine the app supports. */
export const BROWSER_FLOOR = Object.fromEntries(
  ENGINES.map((engine) => [engine, floorOf(engine)]),
) as Record<Engine, Version>;

function dotted([major, minor]: Version): string {
  return minor === undefined ? String(major) : `${major}.${minor}`;
}

/** The floor as Vite's `build.target`: Safari on iOS ships the same engine releases. */
export const BUILD_TARGET: string[] = [
  ...ENGINES.map((engine) => `${engine}${dotted(BROWSER_FLOOR[engine])}`),
  `ios${dotted(BROWSER_FLOOR.safari)}`,
];

/** The floor as Lightning CSS targets: major, minor, patch, one byte each. */
export const LIGHTNINGCSS_TARGETS = Object.fromEntries(
  [...ENGINES.map((engine) => [engine, BROWSER_FLOOR[engine]] as const), ["ios_saf", BROWSER_FLOOR.safari] as const]
    .map(([engine, [major, minor = 0]]) => [engine, (major << 16) | (minor << 8)]),
) as Record<Engine | "ios_saf", number>;

/** public/update-browser.html, served without its extension like the other hand-written pages. */
const UPDATE_BROWSER_PATH = "/update-browser";

/**
 * Sends a browser below the floor to a page that says so, before any of the
 * app's scripts or styles can half-run. Below the floor the stylesheet's
 * colours are invalid, so the app would render without any, and scripts would
 * fail at whichever missing feature they reach first.
 *
 * Runs after the in-app browser script: a webview that is also out of date is
 * better served by being sent to the real browser.
 */
export const UNSUPPORTED_BROWSER_SCRIPT = `(function(){try{if(${REQUIRED_FEATURES.map((feature) => `(${feature.test})`).join("&&")})return;}catch(e){}if(location.pathname.indexOf(${JSON.stringify(UPDATE_BROWSER_PATH)})===0)return;if(window.stop)window.stop();location.replace(${JSON.stringify(`${UPDATE_BROWSER_PATH}.html`)});})();`;

/**
 * Light, dark, or whatever the device is set to.
 *
 * Every colour token is written as `light-dark(<light>, <dark>)`, so the whole
 * theme is one property on the document: `color-scheme`. The stylesheet maps
 * `data-appearance` on `<html>` to it (`styles.css`); with no attribute the
 * document follows the device.
 *
 * The choice lives in a cookie rather than only in the account so the first
 * paint can read it: `APPEARANCE_SCRIPT` runs in `<head>`, before the body is
 * parsed, and sets the attribute — a page never flashes the wrong theme on its
 * way to the right one. The account keeps the choice too, so it follows the
 * person to another device; on sign-in the account's value is written here.
 */
import { APPEARANCES } from "@orbmeet/domain-model";

export type Appearance = (typeof APPEARANCES)[number];

const APPEARANCE_COOKIE = "orb-appearance";

/** A year; the cookie is renewed whenever the choice is written. */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** The browser chrome around the page: the canvas colour of each theme. */
export const THEME_COLOR = { light: "#eeeef1", dark: "#08080b" } as const;

function isAppearance(value: unknown): value is Appearance {
  return typeof value === "string" && (APPEARANCES as readonly string[]).includes(value);
}

/**
 * Runs before first paint. Kept tiny and dependency-free: it is inlined as a
 * string, so it cannot import anything, and an exception here must never stop
 * the page — the stylesheet's default (follow the device) still applies.
 */
export const APPEARANCE_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )${APPEARANCE_COOKIE}=(light|dark)(?:;|$)/);if(m)document.documentElement.setAttribute("data-appearance",m[1]);}catch(e){}})();`;

export function readAppearance(): Appearance {
  if (typeof document === "undefined") return "system";
  const match = new RegExp(`(?:^|; )${APPEARANCE_COOKIE}=([a-z]+)`).exec(document.cookie);
  return match && isAppearance(match[1]) ? match[1] : "system";
}

/** Applies a choice to this document and remembers it on this device. */
export function applyAppearance(appearance: Appearance): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (appearance === "system") root.removeAttribute("data-appearance");
  else root.setAttribute("data-appearance", appearance);

  document.cookie = `${APPEARANCE_COOKIE}=${appearance}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
  applyThemeColor(appearance);
}

/**
 * Tints the browser chrome to match. Two theme-color tags, one per scheme,
 * each scoped by media query: a chosen appearance points both at its own
 * colour; System restores them. The head script cannot do this — the tags
 * come after it — and they are React's to hydrate, so every page calls this
 * once it has hydrated (`__root.tsx`).
 */
export function applyThemeColor(appearance: Appearance): void {
  if (typeof document === "undefined") return;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = meta.media.includes("dark") ? "dark" : "light";
    meta.content = appearance === "system" ? THEME_COLOR[scheme] : THEME_COLOR[appearance];
  }
}

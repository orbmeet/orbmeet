/**
 * OrbMeet never runs inside another app's built-in browser.
 *
 * Facebook, Instagram, TikTok and the rest open links in a webview of their
 * own. Most never grant it the camera or microphone, and the ones that do run
 * it on an engine and an audio route the app cannot reason about — so a
 * meeting there fails in ways that read as "OrbMeet doesn't work". The page
 * cannot stop the app opening it there; what it can do is refuse to start, and
 * hand the link to the real browser.
 *
 * `IN_APP_BROWSER_SCRIPT` does that from `<head>`, on every page — the
 * prerendered ones included, which the Worker never sees. There is no feature
 * to test for, so it reads the user agent. On a match it calls `window.stop()`
 * before the app's own scripts are parsed: that aborts the parser, which
 * discards everything after it (HTML, "abort a parser"), so no bundle runs and
 * nothing asks for a device. It then replaces the page with
 * public/open-in-browser.html, which only these visitors ever download, and
 * which offers the way out. The page OrbMeet was opened on travels as that
 * page's fragment, which is never sent to a server.
 *
 * Like `APPEARANCE_SCRIPT` it is inlined as a string, so it cannot import
 * anything, and an exception in it must never break the page for a real
 * browser.
 */

/** Apps that name themselves in their webview's user agent. */
const NAMED_APP =
  /instagram|fbav|fban|fb_iab|fbiab|fbios|twitter|snapchat|linkedin|wechat|micromessenger|tiktok|musical_ly|bytedance|kakaotalk|\bline\//i;

/** Android's WebView marks itself `; wv)`; Chrome and Custom Tabs do not. */
const ANDROID_WEBVIEW = /;\s?wv\)/;

/** public/open-in-browser.html, named the way the service worker names offline.html. */
const OPEN_IN_BROWSER_PATH = "/open-in-browser.html";

/**
 * Whether a user agent is another app's built-in browser.
 *
 * On iOS every browser, Chrome and Firefox included, carries a `Safari/` token,
 * and a bare WKWebView does not. A home-screen web app may not either, so a
 * standalone page is never treated as one. A touch "Macintosh" is an iPad (see
 * browser-capabilities.ts).
 */
export const IN_APP_BROWSER_DETECTOR = `function(ua,touch,standalone){if(${NAMED_APP}.test(ua))return true;if(/Android/i.test(ua))return ${ANDROID_WEBVIEW}.test(ua);var apple=/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&touch>1);return apple&&!standalone&&/AppleWebKit/.test(ua)&&!/Safari\\//.test(ua);}`;

/**
 * The attribute the script leaves on `<html>` when it matched. Should the app
 * start anyway, joining reads this rather than detecting a second time.
 */
const IN_APP_BROWSER_ATTRIBUTE = "data-in-app-browser";

export const IN_APP_BROWSER_SCRIPT = `(function(){try{var n=navigator,l=location;if(!(${IN_APP_BROWSER_DETECTOR})(n.userAgent||"",n.maxTouchPoints||0,n.standalone===true||(window.matchMedia&&matchMedia("(display-mode: standalone)").matches)))return;document.documentElement.setAttribute(${JSON.stringify(IN_APP_BROWSER_ATTRIBUTE)},"");if(l.pathname.indexOf(${JSON.stringify(OPEN_IN_BROWSER_PATH.replace(/\.html$/, ""))})===0)return;if(window.stop)window.stop();l.replace(${JSON.stringify(OPEN_IN_BROWSER_PATH)}+"#"+encodeURIComponent(l.pathname+l.search+l.hash));}catch(e){}})();`;

/** Whether the head script found this page inside another app's browser. */
export function isInAppBrowserDocument(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute(IN_APP_BROWSER_ATTRIBUTE);
}

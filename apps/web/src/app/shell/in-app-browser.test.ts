// @vitest-environment jsdom
/* oxlint-disable typescript/no-implied-eval -- both scripts ship as source; running that exact source is what is under test. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IN_APP_BROWSER_DETECTOR,
  IN_APP_BROWSER_SCRIPT,
  isInAppBrowserDocument,
} from "./in-app-browser";

type Detect = (ua: string, touch: number, standalone: boolean) => boolean;
const detect = new Function(`return ${IN_APP_BROWSER_DETECTOR}`)() as Detect;

const PUBLIC = join(import.meta.dirname, "../../../public");
const ESCAPE_HTML = readFileSync(join(PUBLIC, "open-in-browser.html"), "utf8");
const ESCAPE_JS = readFileSync(join(PUBLIC, "open-in-browser.js"), "utf8");

// Real user agents. The two Android ones are from the meeting that prompted
// this: the same person in Facebook's browser, then in Chrome.
const UA = {
  facebookAndroid:
    "Mozilla/5.0 (Linux; Android 15; TECNO KM4k Build/AP3A.240905.015.A2; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/154.0.8037.106 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/582.0.0.61.92;]",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
  facebookIPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22H20 [FBAN/FBIOS;FBAV/530.0.0.43.109;FBBV/750123456;FBDV/iPhone17,1;FBMD/iPhone;FBSN/iOS;FBSV/18.7;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/5]",
  instagramIPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 401.0.0.39.82 (iPhone17,1; iOS 18_7; en_US; en; scale=3.00; 1206x2622; 812345678)",
  tiktokAndroid:
    "Mozilla/5.0 (Linux; Android 14; SM-A546E Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.134 Mobile Safari/537.36 trill_350702 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/35.7.2 ByteLocale/en",
  lineIPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.10.0",
  bareWebViewIPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  bareWebViewAndroid:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.134 Mobile Safari/537.36",
  safariIPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
  chromeIPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1",
  firefoxIPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15",
  safariIPadDesktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
  samsungInternet:
    "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
} as const;

const realUserAgent = navigator.userAgent;

function setUserAgent(userAgent: string) {
  Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
}

afterEach(() => {
  setUserAgent(realUserAgent);
  document.documentElement.removeAttribute("data-in-app-browser");
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("the in-app browser detector", () => {
  it.each([
    "facebookAndroid",
    "tiktokAndroid",
    "bareWebViewAndroid",
    "facebookIPhone",
    "instagramIPhone",
    "lineIPhone",
    "bareWebViewIPhone",
  ] as const)("turns away %s", (name) => {
    expect(detect(UA[name], 5, false)).toBe(true);
  });

  it.each([
    "chromeAndroid",
    "safariIPhone",
    "chromeIPhone",
    "firefoxIPhone",
    "safariIPadDesktop",
    "samsungInternet",
    "chromeWindows",
  ] as const)("lets %s through", (name) => {
    expect(detect(UA[name], 5, false)).toBe(false);
  });

  it("does not mistake an installed home-screen app for a webview", () => {
    expect(detect(UA.bareWebViewIPhone, 5, true)).toBe(false);
  });
});

describe("the in-app browser head script", () => {
  function run(userAgent: string) {
    setUserAgent(userAgent);
    const stop = vi.fn();
    vi.stubGlobal("stop", stop);
    // jsdom does not navigate, so the replace itself is left to a real
    // browser; what it must never do is let the load carry on.
    new Function(IN_APP_BROWSER_SCRIPT)();
    return { stop };
  }

  it("cannot end the inline <script> that carries it", () => {
    expect(IN_APP_BROWSER_SCRIPT).not.toContain("</");
  });

  it("leaves a real browser's page alone", () => {
    const { stop } = run(UA.chromeAndroid);
    expect(isInAppBrowserDocument()).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it("stops the load inside another app's browser", () => {
    const { stop } = run(UA.facebookAndroid);
    expect(isInAppBrowserDocument()).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not send the escape page to itself", () => {
    history.replaceState(null, "", "/open-in-browser");
    const { stop } = run(UA.facebookAndroid);
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("the escape page", () => {
  function open(userAgent: string, fragment: string) {
    setUserAgent(userAgent);
    const fetch = vi.fn(() => Promise.resolve(new Response("OK")));
    vi.stubGlobal("fetch", fetch);
    history.replaceState(null, "", `/open-in-browser#${fragment}`);
    document.body.innerHTML = new DOMParser().parseFromString(ESCAPE_HTML, "text/html").body.innerHTML;
    new Function(ESCAPE_JS)();
    const link = document.getElementById("open") as HTMLAnchorElement;
    return { link, fetch };
  }

  it("hands the page to Chrome on Android", () => {
    const { link, fetch } = open(UA.facebookAndroid, encodeURIComponent("/abc-defg-hij?x=1"));
    expect(link.hidden).toBe(false);
    expect(link.textContent).toBe("Open in Chrome");
    expect(link.getAttribute("href")).toBe(
      `intent://${location.host}/abc-defg-hij?x=1#Intent;scheme=https;package=com.android.chrome;end`,
    );
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ event: "in_app_browser_blocked", escape: "android" });
    expect(init.body).not.toContain("abc-defg-hij");
  });

  it("hands the page to Safari on iOS", () => {
    const { link } = open(UA.instagramIPhone, encodeURIComponent("/join/token"));
    expect(link.textContent).toBe("Open in Safari");
    expect(link.getAttribute("href")).toBe(`x-safari-${location.origin}/join/token`);
  });

  it.each([
    ["another origin", encodeURIComponent("https://example.com/")],
    ["a protocol-relative URL", encodeURIComponent("//example.com/")],
    ["a backslash host", encodeURIComponent("/\\example.com/")],
    ["a malformed escape", "%E0%A4%A"],
  ])("refuses %s, falling back to the home page", (_, fragment) => {
    const { link } = open(UA.instagramIPhone, fragment);
    expect(link.getAttribute("href")).toBe(`x-safari-${location.origin}/`);
  });
});

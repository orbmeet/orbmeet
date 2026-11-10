// @vitest-environment jsdom
/* oxlint-disable typescript/no-implied-eval -- the script ships as source; running that exact source is what is under test. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_FLOOR,
  BUILD_TARGET,
  LIGHTNINGCSS_TARGETS,
  UNSUPPORTED_BROWSER_SCRIPT,
} from "./browser-support";

describe("the browser floor", () => {
  it("is the newest first release of every feature the app needs", () => {
    // light-dark() sets Chrome, Edge and Safari; AbortSignal.any sets Firefox.
    expect(BROWSER_FLOOR).toEqual({ chrome: [123], edge: [123], firefox: [124], safari: [17, 5] });
  });

  it("is the build target and the CSS target alike", () => {
    expect(BUILD_TARGET).toEqual(["chrome123", "edge123", "firefox124", "safari17.5", "ios17.5"]);
    expect(LIGHTNINGCSS_TARGETS).toEqual({
      chrome: 123 << 16,
      edge: 123 << 16,
      firefox: 124 << 16,
      safari: (17 << 16) | (5 << 8),
      ios_saf: (17 << 16) | (5 << 8),
    });
  });
});

describe("the unsupported-browser head script", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    history.replaceState(null, "", "/");
  });

  function run({ lightDark, abortAny }: { lightDark: boolean; abortAny: boolean }) {
    vi.stubGlobal("CSS", { supports: (_property: string, value: string) => lightDark && value.startsWith("light-dark(") });
    vi.stubGlobal("AbortSignal", abortAny ? AbortSignal : { ...AbortSignal, any: undefined });
    const stop = vi.fn();
    vi.stubGlobal("stop", stop);
    // jsdom does not navigate, so the replace itself is left to a real
    // browser; what it must never do is let the load carry on.
    new Function(UNSUPPORTED_BROWSER_SCRIPT)();
    return { stop };
  }

  it("cannot end the inline <script> that carries it", () => {
    expect(UNSUPPORTED_BROWSER_SCRIPT).not.toContain("</");
  });

  it("leaves a supported browser's page alone", () => {
    expect(run({ lightDark: true, abortAny: true }).stop).not.toHaveBeenCalled();
  });

  it("stops the load without light-dark(), whose absence leaves the app colourless", () => {
    expect(run({ lightDark: false, abortAny: true }).stop).toHaveBeenCalledOnce();
  });

  it("stops the load without AbortSignal.any()", () => {
    expect(run({ lightDark: true, abortAny: false }).stop).toHaveBeenCalledOnce();
  });

  it("stops the load where the CSS object itself is missing", () => {
    vi.stubGlobal("CSS", undefined);
    const stop = vi.fn();
    vi.stubGlobal("stop", stop);
    new Function(UNSUPPORTED_BROWSER_SCRIPT)();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not send the update page to itself", () => {
    history.replaceState(null, "", "/update-browser");
    expect(run({ lightDark: false, abortAny: false }).stop).not.toHaveBeenCalled();
  });
});

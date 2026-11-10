import { afterEach, describe, expect, it, vi } from "vitest";
import { isCommandK } from "./command-k";

describe("isCommandK", () => {
  afterEach(() => vi.unstubAllGlobals());

  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
  const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
  const on = (userAgent: string) => vi.stubGlobal("navigator", { userAgent, maxTouchPoints: 0 });
  const key = (overrides: Partial<KeyboardEvent>) => ({
    key: "k",
    code: "KeyK",
    isComposing: false,
    keyCode: 75,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  }) as KeyboardEvent;

  it("is ⌘K on a Mac, leaving Ctrl+K to the text field", () => {
    on(MAC);
    expect(isCommandK(key({ metaKey: true }))).toBe(true);
    expect(isCommandK(key({ ctrlKey: true }))).toBe(false);
  });

  it("is Ctrl+K on Windows", () => {
    on(WINDOWS);
    expect(isCommandK(key({ ctrlKey: true, key: "K" }))).toBe(true);
    expect(isCommandK(key({ metaKey: true }))).toBe(false);
  });

  it("ignores a bare K and other chords", () => {
    on(MAC);
    expect(isCommandK(key({}))).toBe(false);
    expect(isCommandK(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isCommandK(key({ metaKey: true, key: "j", code: "KeyJ" }))).toBe(false);
  });
});

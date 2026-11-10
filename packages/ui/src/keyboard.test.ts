import { describe, expect, it } from "vitest";
import { isComposing, isKey, isLetter, isShortcut, shortcutLabel } from "./keyboard";

function press(init: Partial<KeyboardEvent> = {}) {
  return {
    key: "",
    code: "",
    isComposing: false,
    keyCode: 0,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("input methods", () => {
  it("leaves the Enter that confirms a candidate to the IME", () => {
    expect(isKey(press({ key: "Enter", isComposing: true, keyCode: 229 }), "Enter")).toBe(false);
  });

  it("recognises Safari's confirming Enter, which arrives after the composition ended", () => {
    const safari = press({ key: "Enter", isComposing: false, keyCode: 229 });
    expect(isComposing(safari)).toBe(true);
    expect(isKey(safari, "Enter")).toBe(false);
  });

  it("takes an ordinary Enter", () => {
    expect(isKey(press({ key: "Enter", keyCode: 13 }), "Enter")).toBe(true);
  });
});

describe("letters across keyboard layouts", () => {
  it("reads a Latin letter as typed, so Dvorak's K is K wherever it sits", () => {
    expect(isLetter(press({ key: "k", code: "KeyV" }), "k")).toBe(true);
    expect(isLetter(press({ key: "v", code: "KeyK" }), "k")).toBe(false);
  });

  it("falls back to the key's position for a non-Latin letter", () => {
    expect(isLetter(press({ key: "л", code: "KeyK" }), "k")).toBe(true);
    expect(isLetter(press({ key: "κ", code: "KeyK" }), "k")).toBe(true);
    expect(isLetter(press({ key: "л", code: "KeyL" }), "k")).toBe(false);
  });

  it("ignores Chrome's autofill key events, which carry no key", () => {
    expect(isLetter(press({ key: undefined, code: undefined }), "k")).toBe(false);
  });
});

describe("shortcuts", () => {
  it("is ⌘ on Apple platforms, and Ctrl there is left to the text field", () => {
    expect(isShortcut(press({ key: "k", metaKey: true }), "k", true)).toBe(true);
    expect(isShortcut(press({ key: "k", ctrlKey: true }), "k", true)).toBe(false);
  });

  it("is Ctrl elsewhere, and the Windows key is not", () => {
    expect(isShortcut(press({ key: "k", ctrlKey: true }), "k", false)).toBe(true);
    expect(isShortcut(press({ key: "k", metaKey: true }), "k", false)).toBe(false);
  });

  it("refuses AltGr and Shift, which type other characters", () => {
    expect(isShortcut(press({ key: "k", ctrlKey: true, altKey: true }), "k", false)).toBe(false);
    expect(isShortcut(press({ key: "K", ctrlKey: true, shiftKey: true }), "k", false)).toBe(false);
  });

  it("works on a Cyrillic layout", () => {
    expect(isShortcut(press({ key: "л", code: "KeyK", ctrlKey: true }), "k", false)).toBe(true);
  });

  it("is labelled the platform's way", () => {
    expect(shortcutLabel("k", true)).toBe("⌘K");
    expect(shortcutLabel("k", false)).toBe("Ctrl K");
  });
});

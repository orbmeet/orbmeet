import { afterEach, describe, expect, it } from "vitest";

/**
 * loadPaddleJs() caches its script-load promise on the window. A failed load
 * must remove its dead <script>: a later attempt that reused it would attach
 * listeners to an element whose events already fired, and never settle.
 */

interface FakeScript {
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  listeners: Map<string, Array<() => void>>;
  addEventListener(type: string, fn: () => void): void;
  remove(): void;
}

// Assign through an untyped slot: the DOM-lib `Window` type on globalThis is
// not directly assignable, and this stub replaces it wholesale.
const setGlobal = (key: "window" | "document", value: unknown): void => {
  (globalThis as unknown as Record<string, unknown>)[key] = value;
};
const clearGlobal = (key: "window" | "document"): void => {
  delete (globalThis as unknown as Record<string, unknown>)[key];
};

describe("Paddle.js script loading", () => {
  const created: FakeScript[] = [];
  let fakeDocument: {
    createElement(): FakeScript;
    querySelector(selector: string): FakeScript | null;
    head: { appendChild(script: FakeScript): void };
  } | null = null;

  function installFakeDom(): void {
    created.length = 0;
    setGlobal("window", {});
    fakeDocument = {
      createElement(): FakeScript {
        const script: FakeScript = {
          src: "",
          onload: null,
          onerror: null,
          listeners: new Map(),
          addEventListener(type, fn) {
            const list = script.listeners.get(type) ?? [];
            list.push(fn);
            script.listeners.set(type, list);
          },
          remove() {
            const index = created.indexOf(script);
            if (index >= 0) created.splice(index, 1);
          },
        };
        created.push(script);
        return script;
      },
      querySelector(selector: string): FakeScript | null {
        return created.find((script) => selector.includes(script.src)) ?? null;
      },
      head: {
        appendChild(script: FakeScript) {
          script.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
        },
      },
    };
    setGlobal("document", fakeDocument);
  }

  afterEach(() => {
    clearGlobal("window");
    clearGlobal("document");
    fakeDocument = null;
  });

  it("removes a failed script so a later attempt can recover", async () => {
    installFakeDom();
    const mod = await import("./paddle-checkout");

    // Attempt 1: the script fails to load (ad-blocker / network blip).
    const first = mod.getPaddleClient();
    expect(created.length).toBe(1);
    for (const listener of created[0].listeners.get("error") ?? []) listener();
    await expect(first).rejects.toThrow("Failed to load Paddle.js");
    expect(created).toHaveLength(0);

    // Attempt 2 (connectivity restored) creates a fresh script and settles.
    const second = mod.getPaddleClient();
    expect(created.length).toBe(1);
    (globalThis.window as Window).Paddle = {
      Initialize() {},
      Checkout: { open() {} },
    };
    for (const listener of created[0].listeners.get("load") ?? []) listener();
    // The loader settled and continued into client initialization. This fixture
    // intentionally has no Vite token, so that final configuration check fails.
    await expect(second).rejects.toThrow("Paddle client token is not configured");
  }, 5_000);
});

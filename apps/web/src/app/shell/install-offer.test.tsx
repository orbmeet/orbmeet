// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
  installsViaShareSheet: vi.fn(() => true),
  isStandaloneDisplayMode: vi.fn(() => false),
  getPlatformEnvironment: vi.fn(() => ({})),
}));
vi.mock("@/lib/browser-capabilities", () => platform);

const { InstallOffer, resetInstallOfferForTests } = await import("./install-offer");
const { PwaStatus } = await import("./pwa-status");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// This jsdom build ships no Storage, which is precisely the case the component
// guards for — so the persistence contract needs one supplied to be observable.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
});

let container: HTMLElement;
let root: Root;

async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(node));
}

function offer(): HTMLElement | null {
  return container.querySelector('aside[aria-label="Install Orb Meet"]');
}

beforeEach(() => {
  localStorage.clear();
  resetInstallOfferForTests();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("install offer", () => {
  /**
   * Dismissing a promotional offer has to mean "stop asking". It previously
   * lived in component state alone, so the banner returned on every page load.
   */
  it("stays gone after it is dismissed", async () => {
    await mount(<InstallOffer variant="strip" />);
    expect(offer()).not.toBeNull();

    const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!;
    await act(async () => dismiss.click());

    expect(offer()).toBeNull();
    expect(localStorage.getItem("orbmeet.pwa.install-offer-dismissed")).toBe("1");
  });

  it("does not come back on the next page load", async () => {
    localStorage.setItem("orbmeet.pwa.install-offer-dismissed", "1");

    await mount(<InstallOffer variant="strip" />);

    expect(offer()).toBeNull();
  });

  it("dismissing one placement dismisses both", async () => {
    await mount(
      <>
        <InstallOffer variant="card" />
        <InstallOffer variant="strip" />
      </>,
    );
    expect(container.querySelectorAll('aside[aria-label="Install Orb Meet"]')).toHaveLength(2);

    const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!;
    await act(async () => dismiss.click());

    expect(offer()).toBeNull();
  });

  it("is a labelled aside rather than a live region, so it interrupts nothing", async () => {
    await mount(<InstallOffer variant="strip" />);

    expect(offer()?.getAttribute("aria-live")).toBeNull();
  });

  it("is not offered inside the installed app", async () => {
    platform.isStandaloneDisplayMode.mockReturnValueOnce(true);

    await mount(<InstallOffer variant="strip" />);

    expect(offer()).toBeNull();
  });

  /**
   * The offer no longer floats: the root no longer renders it at all, so it
   * cannot be layered over a page, a form, or the whiteboard canvas.
   */
  it("is never rendered by the root overlay", async () => {
    await mount(<PwaStatus />);

    expect(offer()).toBeNull();
  });
});

describe("connectivity", () => {
  /** Losing the network is the one thing here worth interrupting for. */
  it("announces going offline", async () => {
    await mount(<PwaStatus />);
    await act(async () => void window.dispatchEvent(new Event("offline")));

    const notice = container.querySelector("aside");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.getAttribute("aria-live")).toBe("polite");
    expect(notice?.textContent).toContain("You’re offline");
  });
});

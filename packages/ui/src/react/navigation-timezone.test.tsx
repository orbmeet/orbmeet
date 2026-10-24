// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { MenuContent, MenuLinkItem, MenuRoot, MenuTrigger } from "./menu";
import { TimeZoneSelect } from "./timezone-select";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function render(content: ReactElement, check: (container: HTMLElement) => Promise<void>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(content));
    await check(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

describe("menu navigation", () => {
  it.each([true, false])("closes on navigation unless explicitly opted out (close=%s)", async (close) => {
    const navigate = vi.fn();
    await render(
      <MenuRoot defaultOpen>
        <MenuTrigger>Account</MenuTrigger>
        <MenuContent>
          <MenuLinkItem
            {...(close ? {} : { closeOnClick: false })}
            href="#settings"
            onClick={(event) => { event.preventDefault(); navigate(); }}
          >Settings</MenuLinkItem>
        </MenuContent>
      </MenuRoot>,
      async (container) => {
        await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click());
        expect(navigate).toHaveBeenCalledOnce();
        expect(container.querySelector("button")!.getAttribute("aria-expanded")).toBe(String(!close));
      },
    );
  });
});

describe("timezone choices and search", () => {
  it.each([
    ["UTC", "Asia/Dhaka", "UTC"],
    ["Asia/Dhaka", "Europe/Berlin", "Asia/Dhaka"],
    ["  america/New_York  ", "Asia/Dhaka", "America/New York"],
    ["Dhaka", "Asia/Dhaka", "Asia/Dhaka"],
    ["us/eastern", "US/Eastern", "US/Eastern"],
  ])("finds and selects %s", async (query, value, label) => {
    const onChange = vi.fn();
    await render(<TimeZoneSelect label="Time zone" value={value} onChange={onChange} />, async (container) => {
      await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Search time zones"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(options).toHaveLength(1);
      expect(options[0].textContent).toContain(label);
      await act(async () => options[0].click());
      const chosenValue = label.replaceAll(" ", "_");
      expect(onChange).toHaveBeenCalledExactlyOnceWith(chosenValue);
    });
  });
});

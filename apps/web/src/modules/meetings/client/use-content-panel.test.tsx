// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MeetingSideColumnTab } from "./room-layout";
import type { MeetingSidePanel } from "./use-meeting-ui";
import { useContentPanel } from "./use-content-panel";

let root: Root | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  // The panel choice is remembered per device; give every test a fresh one.
  const items = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
      clear: () => items.clear(),
    },
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

interface Props {
  contentOnStage: boolean;
  contentPanel: MeetingSideColumnTab | null;
}

/** The hook over a real panel state, as the room's UI state holds it. */
function mount(initial: Props) {
  let panel: MeetingSidePanel | null = null;
  let setPanelOutside: (next: MeetingSidePanel | null) => void = () => {};
  function Probe(props: Props) {
    const [current, setCurrent] = React.useState<MeetingSidePanel | null>(null);
    panel = current;
    setPanelOutside = setCurrent;
    useContentPanel({
      ...props,
      ui: { panel: current, openPanel: setCurrent, closePanel: () => setCurrent(null) },
    });
    return null;
  }
  root ??= createRoot(document.createElement("div"));
  const render = (props: Props) => act(() => root!.render(<Probe {...props} />));
  render(initial);
  return {
    render,
    panel: () => panel,
    choose: (next: MeetingSidePanel | null) => act(() => setPanelOutside(next)),
  };
}

describe("useContentPanel", () => {
  it("opens the room's choice when the board arrives, and closes it when the board goes", () => {
    const room = mount({ contentOnStage: false, contentPanel: "people" });
    room.render({ contentOnStage: true, contentPanel: "people" });
    expect(room.panel()).toBe("people");
    room.render({ contentOnStage: false, contentPanel: "people" });
    expect(room.panel()).toBeNull();
  });

  it("follows a camera turning on or off while the room's own choice is up", () => {
    const room = mount({ contentOnStage: false, contentPanel: "timeline" });
    room.render({ contentOnStage: true, contentPanel: "timeline" });
    expect(room.panel()).toBe("timeline");

    room.render({ contentOnStage: true, contentPanel: "people" });
    expect(room.panel()).toBe("people");

    room.render({ contentOnStage: true, contentPanel: "timeline" });
    expect(room.panel()).toBe("timeline");
  });

  it("leaves a panel someone chose themselves alone", () => {
    const room = mount({ contentOnStage: false, contentPanel: "timeline" });
    room.render({ contentOnStage: true, contentPanel: "timeline" });
    room.choose("people");

    room.render({ contentOnStage: true, contentPanel: "timeline" });
    expect(room.panel()).toBe("people");
  });

  it("does not take the room closing a panel for someone choosing a wide board", () => {
    // Upright screens: the Timeline opens with nobody on camera, and closes
    // when a camera comes on — the faces are under the page there.
    const room = mount({ contentOnStage: false, contentPanel: "timeline" });
    room.render({ contentOnStage: true, contentPanel: "timeline" });
    room.render({ contentOnStage: true, contentPanel: null });
    expect(room.panel()).toBeNull();

    room.render({ contentOnStage: false, contentPanel: null });
    room.render({ contentOnStage: true, contentPanel: "timeline" });
    expect(room.panel()).toBe("timeline");
  });

  it("remembers someone closing the panel, and opens the next board wide", () => {
    const room = mount({ contentOnStage: false, contentPanel: "people" });
    room.render({ contentOnStage: true, contentPanel: "people" });
    room.choose(null);
    room.render({ contentOnStage: false, contentPanel: "people" });

    room.render({ contentOnStage: true, contentPanel: "people" });
    expect(room.panel()).toBeNull();
  });
});

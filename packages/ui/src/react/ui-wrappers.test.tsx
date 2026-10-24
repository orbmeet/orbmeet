/**
 * Contract tests for the Base UI wrappers.
 *
 * Two things are checked, because two different mistakes are possible:
 *
 * 1. **Shape** — what the wrapper puts into the parent's layout. Rendered with
 *    `react-dom/server`, which is enough for every wrapper whose markup is
 *    inline. Portalled parts (Dialog, Popover, Menu popups) render nothing
 *    without a DOM, so their contract is checked at the type level instead.
 * 2. **Prop surface** — a wrapper that declares a closed prop list silently
 *    drops every `aria-*` and `data-*` a caller passes, and TypeScript does not
 *    excess-property-check hyphenated JSX attributes, so nothing complains. The
 *    type-level assertions below fail `tsc` the moment a wrapper narrows away
 *    Base UI's own props again.
 */
// @vitest-environment jsdom

import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Avatar } from "./avatar";
import {
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { FilterInput } from "./filter-input";
import { Input } from "./input";
import { MenuContent, MenuItem } from "./menu";
import { PopoverContent, PopoverRoot } from "./popover";
import { Select } from "./select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";
import { TimeZoneSelect } from "./timezone-select";

const options = [
  { label: "Member", value: "member" },
  { label: "Admin", value: "admin" },
];

/**
 * A caller's own style, used below to check that `sx` reaches the element the
 * wrapper documents it as reaching. Reading the generated class back off
 * `stylex.props` rather than hard-coding a hash keeps the assertion honest
 * without pinning it to StyleX's naming.
 */
const overrides = stylex.create({
  compact: { height: 36, width: 128 },
  loudPadding: { paddingInline: 40 },
});

function classOf(style: StyleXStyles): string {
  return stylex.props(style).className ?? "";
}

describe("Select", () => {
  it("emits a single element when it renders a label", () => {
    // Select.Root renders no element of its own, so an unwrapped Label and
    // Trigger would arrive in the parent flex row or grid as two children.
    const html = renderToStaticMarkup(
      <Select label="Role" value="member" options={options} />,
    );
    expect(html.startsWith("<div ")).toBe(true);
    expect(html.indexOf("<button")).toBeGreaterThan(html.indexOf("Role"));
    expect(countTopLevelElements(withoutHiddenInput(html))).toBe(1);
  });

  it("leaves the trigger as the only in-flow element without a label", () => {
    const html = renderToStaticMarkup(<Select value="member" options={options} />);
    expect(html.startsWith("<button")).toBe(true);
  });

  it("applies sx to the trigger so callers can size the control", () => {
    // Sizing a Select means sizing the control itself, not the wrapper — a
    // caller's width has to land on the button or the popup anchors wrong.
    const html = renderToStaticMarkup(
      <Select value="member" options={options} sx={overrides.compact} />,
    );
    const trigger = /<button[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    for (const cls of classOf(overrides.compact).split(" ")) {
      expect(trigger.split(" ")).toContain(cls);
    }
  });

  it("forwards an accessible name to the trigger", () => {
    const html = renderToStaticMarkup(
      <Select value="member" options={options} aria-label="Filter by role" />,
    );
    expect(html).toContain('aria-label="Filter by role"');
  });
});

describe("Input", () => {
  it("drives Field's invalid state from the error prop", () => {
    const html = renderToStaticMarkup(<Input label="Email" error="That address is not valid." />);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("That address is not valid.");
  });

  it("stays valid without one", () => {
    const html = renderToStaticMarkup(<Input label="Email" />);
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("supports an explicit accessible name for compact layouts", () => {
    const html = renderToStaticMarkup(<Input aria-label="Member email address" />);
    expect(html).toContain('aria-label="Member email address"');
  });
});

describe("Tabs", () => {
  it("forwards hyphenated attributes through the wrappers", () => {
    const html = renderToStaticMarkup(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one" aria-label="First tab">
            One
          </TabsTrigger>
        </TabsList>
        <TabsContent value="one" data-section="one">
          Body
        </TabsContent>
      </Tabs>,
    );
    expect(html).toContain('aria-label="First tab"');
    expect(html).toContain('data-section="one"');
  });

  it("lets a caller's sx win over the variant it is layered on", () => {
    // The whole point of passing styles rather than class strings: the wrapper
    // sets the variant's padding, the caller overrides it, and the loser is
    // dropped outright instead of both landing and emit order deciding.
    const variantOnly = renderToStaticMarkup(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const overridden = renderToStaticMarkup(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one" sx={overrides.loudPadding}>
            One
          </TabsTrigger>
        </TabsList>
      </Tabs>,
    );

    const classesOf = (html: string) =>
      new Set((/<button[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "").split(" "));
    const base = classesOf(variantOnly);
    const merged = classesOf(overridden);

    for (const cls of classOf(overrides.loudPadding).split(" ")) {
      expect(merged).toContain(cls);
    }
    // Only the variant's own inline padding was replaced: its phone value and
    // its value from `sm` up, one class each.
    expect([...base].filter((cls) => !merged.has(cls))).toHaveLength(2);
  });
});

describe("Avatar", () => {
  it("names itself through a role ARIA allows naming", () => {
    const html = renderToStaticMarkup(<Avatar name="Ada Lovelace" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Ada Lovelace"');
  });

  it("says whether someone is online, not only with the dot's colour", () => {
    expect(renderToStaticMarkup(<Avatar name="Ada Lovelace" online />)).toContain(
      'aria-label="Ada Lovelace, online"',
    );
  });
});

describe("FilterInput", () => {
  it("carries an accessible name beyond the placeholder", () => {
    const html = renderToStaticMarkup(
      <FilterInput label="Search Spaces" value="" onChange={() => {}} />,
    );
    expect(html).toContain('aria-label="Search Spaces"');
  });
});

describe("PopoverContent", () => {
  it("uses its required title as the popup's accessible name", async () => {
    await withRenderedPopover(
      <PopoverContent title="Audio settings">Audio controls</PopoverContent>,
      (popup) => expect(popup.getAttribute("aria-label")).toBe("Audio settings"),
    );
  });

  it("lets an explicit aria-label override the title fallback", async () => {
    await withRenderedPopover(
      <PopoverContent title="Audio settings" aria-label="Microphone settings">
        Audio controls
      </PopoverContent>,
      (popup) => expect(popup.getAttribute("aria-label")).toBe("Microphone settings"),
    );
  });
});

async function withRenderedPopover(
  content: ReactElement,
  assertion: (popup: Element) => void,
): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<PopoverRoot defaultOpen>{content}</PopoverRoot>);
    });
    const popup = document.querySelector('[role="dialog"]');
    expect(popup).not.toBeNull();
    assertion(popup!);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

describe("TimeZoneSelect", () => {
  it("labels the trigger and shows the current zone", () => {
    const html = renderToStaticMarkup(
      <TimeZoneSelect label="Time zone" value="Europe/Berlin" onChange={() => {}} />,
    );
    expect(html).toContain("Time zone");
    expect(html).toContain("Europe/Berlin");
    // The list is portalled, so nothing of it is in the inline markup — which is
    // the whole point: it cannot be clipped by a scrolling dialog popup.
    expect(html).not.toContain("Search city or offset");
  });
});

/* ── Prop surface (compile-time) ─────────────────────────────────────────────
   Each of these is a real prop of the Base UI part behind the wrapper. If a
   wrapper goes back to a hand-written prop list, these stop compiling. */

const _closeTakesRenderAndAria: ComponentProps<typeof DialogClose> = {
  render: <button type="button" aria-label="Close" />,
  "aria-label": "Close",
};
const _titleTakesAria: ComponentProps<typeof DialogTitle> = { "aria-level": 2 };
const _descriptionTakesId: ComponentProps<typeof DialogDescription> = { id: "d" };
const _headerTakesId: ComponentProps<typeof DialogHeader> = { id: "header" };
const _bodyTakesAria: ComponentProps<typeof DialogBody> = { "aria-busy": true };
const _footerTakesRole: ComponentProps<typeof DialogFooter> = { role: "group" };
const _menuItemTakesCloseOnClick: ComponentProps<typeof MenuItem> = { closeOnClick: false };
const _menuContentTakesAria: ComponentProps<typeof MenuContent> = { "aria-label": "Account" };
const _dialogContentTakesSx: ComponentProps<typeof DialogContent> = {
  children: null,
  sx: overrides.compact,
};
const _menuItemTakesSx: ComponentProps<typeof MenuItem> = { sx: overrides.compact };
const _popoverContentIsNamed: ComponentProps<typeof PopoverContent> = {
  title: "Audio settings",
  children: null,
  sx: overrides.compact,
};
const _tabsTriggerTakesAria: ComponentProps<typeof TabsTrigger> = {
  value: "one",
  "aria-label": "First tab",
};

// Referencing them keeps the bindings from being elided before tsc sees them.
it("keeps the wrappers' Base UI prop surface open", () => {
  expect([
    _closeTakesRenderAndAria,
    _titleTakesAria,
    _descriptionTakesId,
    _headerTakesId,
    _bodyTakesAria,
    _footerTakesRole,
    _menuItemTakesCloseOnClick,
    _menuContentTakesAria,
    _dialogContentTakesSx,
    _menuItemTakesSx,
    _popoverContentIsNamed,
    _tabsTriggerTakesAria,
  ]).toHaveLength(12);
});

/**
 * Select.Root also emits a `position: fixed` hidden input for form submission.
 * It is out of flow and never a layout participant, so the shape assertions
 * above are about what is left once it is dropped.
 */
function withoutHiddenInput(html: string): string {
  return html.replace(/<input[^>]*aria-hidden="true"[^>]*\/>/g, "");
}

/** Counts elements at depth 0 of a fragment of static markup. */
function countTopLevelElements(html: string): number {
  let depth = 0;
  let count = 0;
  for (const match of html.matchAll(/<(\/?)([a-zA-Z][^\s/>]*)([^>]*?)(\/?)>/g)) {
    const [, closing, , , selfClosing] = match;
    if (closing) {
      depth -= 1;
      continue;
    }
    if (depth === 0) count += 1;
    if (!selfClosing && !voidElements.has(match[2])) depth += 1;
  }
  return count;
}

const voidElements = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

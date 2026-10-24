import type { Browser, BrowserContext, Page } from "@playwright/test";
import { drawStroke, expect, pageFrames, startMeeting, test } from "./support.ts";

// Following the presenter on every kind of screen a meeting runs on. Each
// follower reads at its own size: the presenter's page and place carry over,
// the presenter's zoom does not.

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const SCREENS = {
  "iPad landscape": { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, userAgent: IPAD_UA },
  "iPad portrait": { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, userAgent: IPAD_UA },
  "Phone portrait": { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, userAgent: IPHONE_UA },
  "Phone landscape": { viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, userAgent: IPHONE_UA },
} as const;
type ScreenName = keyof typeof SCREENS;

/** A guest on `screen`, in the meeting at `link`. */
async function joinOn(browser: Browser, contexts: BrowserContext[], link: string, screen: ScreenName): Promise<Page> {
  const context = await browser.newContext({
    ...SCREENS[screen],
    isMobile: true,
    hasTouch: true,
    permissions: ["camera", "microphone"],
  });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(link);
  await page.getByLabel("Your name").fill(screen);
  await page.getByRole("button", { name: /^Join meeting$/ }).click({ timeout: 60_000 });
  // A toolbar on a tablet, a dock on a phone.
  await expect(page.locator('[aria-label="Meeting controls"]')).toBeVisible({ timeout: 60_000 });
  return page;
}

/** The presenter adds a page at the end, opening the page list for it if it is closed. */
async function addPage(host: Page): Promise<void> {
  const add = host.getByRole("button", { name: "Add page at end" });
  if (!(await add.isVisible())) await host.getByRole("button", { name: /^Page \d+ of \d+\. Show all pages/ }).click();
  await add.click();
}

interface Seen {
  /** The board's zoom. */
  zoom: number;
  /** Which part of the page is on screen and not under the board's chrome, as fractions of it. */
  top: number;
  bottom: number;
  following: boolean;
}

/** What `page` shows of page `number` of the board: the part not off screen or under chrome. */
function seen(page: Page, number: number): Promise<Seen | null> {
  return page.evaluate((pageNumber) => {
    const transform = document.querySelector<HTMLElement>(".tl-html-layer")?.style.transform ?? "";
    const zoom = Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? Number.NaN);
    const ty = (element: Element) => new DOMMatrix((element as HTMLElement).style.transform).m42;
    const frame = [...document.querySelectorAll('[data-shape-type="whiteboard-page"]')].sort((a, b) => ty(a) - ty(b))[
      pageNumber - 1
    ];
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    const steps = 40;
    let top = 1;
    let bottom = 0;
    for (let row = 0; row < steps; row++) {
      const fy = (row + 0.5) / steps;
      const y = rect.top + fy * rect.height;
      if (y < 0 || y >= innerHeight) continue;
      for (const fx of [0.25, 0.5, 0.75]) {
        const hit = document.elementFromPoint(rect.left + fx * rect.width, y);
        if (!hit?.closest(".tl-canvas")) continue;
        top = Math.min(top, fy - 0.5 / steps);
        bottom = Math.max(bottom, fy + 0.5 / steps);
      }
    }
    return { zoom, top, bottom, following: /Following /.test(document.body.innerText) };
  }, number);
}

/** What `page` shows of page `number` once it has stopped moving. */
async function settled(page: Page, number: number): Promise<Seen> {
  let last = "";
  let view: Seen | null = null;
  await expect
    .poll(async () => {
      view = await seen(page, number);
      const now = JSON.stringify(view);
      const still = now === last;
      last = now;
      return still && view !== null;
    }, { intervals: [300] })
    .toBe(true);
  return view!;
}

test.describe("following the presenter on every screen", () => {
  test.setTimeout(240_000);

  test("everyone sees the presenter's page whole, whatever the presenter zooms, scrolls or writes", async ({
    browser,
    signUp,
  }) => {
    const contexts: BrowserContext[] = [];
    try {
      const host = await signUp("Alice Host");
      await host.setViewportSize({ width: 1440, height: 900 });
      const link = await startMeeting(host);
      const guests = {} as Record<ScreenName, Page>;
      for (const screen of Object.keys(SCREENS) as ScreenName[]) {
        guests[screen] = await joinOn(browser, contexts, link, screen);
      }
      await host.getByRole("button", { name: "Open the board for everyone" }).click();
      await expect(host.getByRole("button", { name: "Draw", exact: true })).toBeVisible({ timeout: 60_000 });
      for (const guest of Object.values(guests)) await expect(pageFrames(guest)).toHaveCount(1, { timeout: 60_000 });

      // The presenter adds a page: everyone turns to it and sees its top.
      await addPage(host);
      await expect(pageFrames(host)).toHaveCount(2);
      for (const [screen, guest] of Object.entries(guests)) {
        await expect
          .poll(async () => (await seen(guest, 2))?.top ?? 1, { message: `${screen} sees the top of page 2` })
          .toBeLessThan(0.05);
      }

      // Every screen shows all of the page, once it has arrived.
      for (const [screen, guest] of Object.entries(guests)) {
        await expect
          .poll(async () => (await seen(guest, 2))?.bottom ?? 0, { message: `${screen} sees the whole page` })
          .toBeGreaterThan(0.95);
      }
      const before = {} as Record<ScreenName, number>;
      for (const [screen, guest] of Object.entries(guests) as [ScreenName, Page][]) {
        before[screen] = (await settled(guest, 2)).zoom;
      }

      // The presenter zooms right in: nobody else's zoom changes, and they still follow.
      const canvas = (await host.locator(".tl-canvas").boundingBox())!;
      await host.mouse.move(canvas.x + canvas.width * 0.7, canvas.y + canvas.height * 0.7);
      await host.keyboard.down("Control");
      for (let step = 0; step < 10; step++) await host.mouse.wheel(0, -60);
      await host.keyboard.up("Control");
      await host.waitForTimeout(1_500);
      for (const [screen, guest] of Object.entries(guests) as [ScreenName, Page][]) {
        const view = (await seen(guest, 2))!;
        expect(view.zoom, `${screen} keeps its zoom`).toBeCloseTo(before[screen], 3);
        expect(view.following, `${screen} still follows`).toBe(true);
      }

      // Writing at the page's edges moves nobody: the page stays whole on every screen.
      await host.getByRole("button", { name: /^Zoom \d+%\. Fit the page$/ }).click();
      await drawStroke(host, { x: 40, y: 150 });
      await drawStroke(host, { x: 850, y: 150 });
      await host.waitForTimeout(1_500);
      for (const [screen, guest] of Object.entries(guests) as [ScreenName, Page][]) {
        const view = (await seen(guest, 2))!;
        expect(view.top, `${screen} still shows the page's top`).toBeLessThan(0.05);
        expect(view.bottom, `${screen} still shows the page's bottom`).toBeGreaterThan(0.95);
        expect(view.zoom, `${screen} keeps its zoom`).toBeCloseTo(before[screen], 3);
      }
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });

  test("a follower who pinches looks on their own, and goes back to the whole page", async ({ browser, signUp }) => {
    const contexts: BrowserContext[] = [];
    try {
      const host = await signUp("Alice Host");
      await host.setViewportSize({ width: 1440, height: 900 });
      const link = await startMeeting(host);
      const ipad = await joinOn(browser, contexts, link, "iPad landscape");
      await host.getByRole("button", { name: "Open the board for everyone" }).click();
      await expect(pageFrames(ipad)).toHaveCount(1, { timeout: 60_000 });
      const fit = (await seen(ipad, 1))!.zoom;

      // A pinch, as Chrome reports one: a wheel with Control held.
      const board = (await ipad.locator(".tl-canvas").boundingBox())!;
      await ipad.mouse.move(board.x + board.width / 2, board.y + board.height / 2);
      await ipad.keyboard.down("Control");
      for (let step = 0; step < 6; step++) await ipad.mouse.wheel(0, -40);
      await ipad.keyboard.up("Control");
      await expect.poll(async () => (await seen(ipad, 1))!.zoom).toBeGreaterThan(fit * 1.2);
      expect((await seen(ipad, 1))!.following).toBe(false);

      // Back to the presenter: their page, whole, as before.
      await ipad.getByRole("button", { name: "Back to Alice Host" }).click();
      await addPage(host);
      await expect.poll(async () => (await seen(ipad, 2))?.top ?? 1).toBeLessThan(0.05);
      await expect.poll(async () => (await seen(ipad, 2))?.bottom ?? 0).toBeGreaterThan(0.95);
      expect((await seen(ipad, 2))!.following).toBe(true);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });

  test("handing the board to someone who can't write gives them access, and the room follows them", async ({
    browser,
    signUp,
  }) => {
    const contexts: BrowserContext[] = [];
    try {
      const host = await signUp("Alice Host");
      await host.setViewportSize({ width: 1440, height: 900 });
      const link = await startMeeting(host);
      const ipad = await joinOn(browser, contexts, link, "iPad landscape");
      await host.getByRole("button", { name: "Open the board for everyone" }).click();
      await expect(ipad.getByRole("button", { name: "Ask to edit" })).toBeVisible({ timeout: 60_000 });

      await host.getByRole("button", { name: "Hand off navigation control" }).click();
      await expect(host.getByText("Gets edit access too")).toBeVisible();
      await host.getByRole("button", { name: /^iPad landscape/ }).click();

      await expect(ipad.getByRole("button", { name: "Draw", exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(host.getByText("Following iPad landscape")).toBeVisible({ timeout: 30_000 });
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
});

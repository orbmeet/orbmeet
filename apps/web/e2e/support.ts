// Shared steps for the smoke tests. Each test signs up its own accounts and
// starts its own meeting, so tests never share state.
import { readFileSync } from "node:fs";
import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { WEB_URL, WHITEBOARD_PID_FILE, WHITEBOARD_URL } from "./stack.ts";

/** The local explorer's API over the email the dev Worker "sent". */
const SENT_EMAIL_API = `${WEB_URL}/cdn-cgi/local/explorer/api/local/email/sending`;

const JOIN_BUTTON = /^(Join meeting|Start meeting)$/;

interface SentEmail {
  messageId: string;
  to: string[];
  sentAt: string;
}

/** The newest code mailed to `email` since `since`, read from the simulated send. */
async function readMailedCode(page: Page, email: string, since: number): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const list = (await (await page.request.get(SENT_EMAIL_API)).json()) as { result: SentEmail[] };
        const message = list.result
          .filter((sent) => sent.to.includes(email) && Date.parse(sent.sentAt) >= since)
          .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))[0];
        if (!message) return undefined;
        const detail = await page.request.get(SENT_EMAIL_API, { params: { email_id: message.messageId } });
        code = JSON.stringify(await detail.json()).match(/\b(\d{6})\b/)?.[1];
        return code;
      },
      { message: `a code mailed to ${email}` },
    )
    .toBeTruthy();
  return code!;
}

let accounts = 0;

/** Signs a new account up through the email-code flow, in a browser context of its own. */
async function signUp(browser: Browser, contexts: BrowserContext[], name: string): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  const email = `${name.toLowerCase().replace(/\W+/g, "-")}-${Date.now()}-${++accounts}@orbmeet-e2e.dev`;
  const since = Date.now() - 1_000;
  await page.goto("/auth");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.getByLabel("Full name").fill(name);
  await page.getByRole("button", { name: /continue|create|send/i }).last().click();
  const code = await readMailedCode(page, email, since);
  await page.getByLabel("Verification code").first().pressSequentially(code);
  await page.waitForURL((url) => !/\/(auth|verify)\b/.test(url.pathname));
  return page;
}

type SignUp = (name: string) => Promise<Page>;

/**
 * `signUp` gives a test one signed-in person per call. Their browser contexts
 * close when the test ends, so no meeting outlives its test.
 */
export const test = base.extend<{ signUp: SignUp }>({
  // Playwright reads only the first parameter; the second is not a React hook.
  signUp: async ({ browser }, provide) => {
    const contexts: BrowserContext[] = [];
    await provide((name) => signUp(browser, contexts, name));
    await Promise.all(contexts.map((context) => context.close()));
  },
});

export { expect };

/** Passes the pre-join screen and waits until the page is in the meeting. */
export async function joinFromPreJoin(page: Page): Promise<void> {
  // The first visit compiles the meeting chunks in the dev server.
  await page.getByRole("button", { name: JOIN_BUTTON }).click({ timeout: 60_000 });
  await expect(page.getByRole("toolbar", { name: "Meeting controls" })).toBeVisible({ timeout: 60_000 });
}

/** Starts a meeting from the home page and joins it; returns its link. */
export async function startMeeting(host: Page): Promise<string> {
  await host.getByRole("main").getByRole("button", { name: "New meeting" }).click();
  await joinFromPreJoin(host);
  return host.url();
}

export async function joinMeeting(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await joinFromPreJoin(page);
}

/** A host and a guest in one meeting, with the board open for everyone. */
export async function meetingWithBoard(signUp: SignUp) {
  const host = await signUp("Alice Host");
  const link = await startMeeting(host);
  const guest = await signUp("Bob Guest");
  await joinMeeting(guest, link);
  await host.getByRole("button", { name: "Open the board for everyone" }).click();
  await expect(host.getByRole("button", { name: "Draw", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(guest.getByRole("button", { name: "Ask to edit" })).toBeVisible({ timeout: 60_000 });
  // The host's client gives a new board its first page; until both sides
  // have it, the board is still being set up.
  await expect(pageFrames(host)).toHaveCount(1);
  await expect(pageFrames(guest)).toHaveCount(1);
  return { host, guest, link };
}

/** The guest asks to edit the board and the host approves. */
export async function grantEditAccess(host: Page, guest: Page, guestName = "Bob Guest"): Promise<void> {
  await guest.getByRole("button", { name: "Ask to edit" }).click();
  await host.getByRole("button", { name: `Approve whiteboard access for ${guestName}` }).click();
  await expect(guest.getByRole("button", { name: "Draw", exact: true })).toBeVisible();
}

/** The board's page frames as this page renders them. */
export function pageFrames(page: Page) {
  return page.locator('.tl-shape[data-shape-type="whiteboard-page"]');
}

/** The freehand strokes on the board as this page renders it. */
export function strokes(page: Page) {
  return page.locator('.tl-shape[data-shape-type="draw"]');
}

/** The point at `offset` from the middle of the canvas. */
async function canvasPoint(page: Page, offset: { x: number; y: number }) {
  const box = await page.locator(".tl-canvas").boundingBox();
  if (!box) throw new Error("The board canvas is not on screen");
  return { x: box.x + box.width / 2 + offset.x, y: box.y + box.height / 2 + offset.y };
}

/**
 * Draws one freehand stroke starting at `offset` from the canvas middle.
 * `midway` runs between the stroke's halves, with the pointer still down.
 */
export async function drawStroke(
  page: Page,
  offset: { x: number; y: number },
  midway?: () => Promise<void>,
): Promise<void> {
  await page.getByRole("button", { name: "Draw", exact: true }).click();
  const start = await canvasPoint(page, offset);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 5; step++) await page.mouse.move(start.x + step * 8, start.y + step * 5);
  if (midway) await midway();
  // A layout change may have moved the canvas; continue from where it is now.
  const resume = await canvasPoint(page, { x: offset.x + 40, y: offset.y + 25 });
  for (let step = 1; step <= 5; step++) await page.mouse.move(resume.x + step * 8, resume.y + step * 5);
  await page.mouse.up();
}

function whiteboardPid(): number {
  return Number(readFileSync(WHITEBOARD_PID_FILE, "utf8"));
}

/** Restarts the whiteboard server as a deploy does (SIGTERM, then a fresh start). */
export async function restartWhiteboardServer(): Promise<void> {
  const before = whiteboardPid();
  process.kill(before, "SIGTERM");
  await expect
    .poll(
      async () => {
        if (whiteboardPid() === before) return false;
        const health = await fetch(`${WHITEBOARD_URL}/health`).catch(() => null);
        return health?.ok ?? false;
      },
      { message: "the whiteboard server to come back", timeout: 30_000 },
    )
    .toBe(true);
}

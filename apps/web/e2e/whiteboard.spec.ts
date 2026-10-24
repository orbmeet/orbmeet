import type { Page } from "@playwright/test";
import {
  drawStroke,
  expect,
  grantEditAccess,
  joinMeeting,
  meetingWithBoard,
  restartWhiteboardServer,
  startMeeting,
  strokes,
  test,
} from "./support.ts";

/** The pager's "Page 2 of 3" control. */
function pager(page: Page) {
  return page.getByRole("button", { name: /^Page \d+ of \d+\./ });
}

test("two people see each other's strokes live", async ({ signUp }) => {
  const { host, guest } = await meetingWithBoard(signUp);

  await drawStroke(host, { x: -200, y: -60 });
  await expect(strokes(host)).toHaveCount(1);
  await expect(strokes(guest)).toHaveCount(1);

  await grantEditAccess(host, guest);
  await drawStroke(guest, { x: 100, y: 60 });
  await expect(strokes(guest)).toHaveCount(2);
  await expect(strokes(host)).toHaveCount(2);
});

test("a person removed mid-session loses the board", async ({ signUp }) => {
  const { host, guest, link } = await meetingWithBoard(signUp);
  await grantEditAccess(host, guest);
  await drawStroke(guest, { x: -100, y: 0 });
  await expect(strokes(host)).toHaveCount(1);

  // People, beside the board under the faces, has what may be done to each.
  // The top bar opens it: the panel has a title, not a second set of tabs.
  await host.getByRole("toolbar", { name: "Meeting controls" }).getByRole("button", { name: /^People · / }).click();
  await host.getByRole("button", { name: "Remove Bob Guest from meeting" }).click();
  await host.getByRole("button", { name: "Remove", exact: true }).click();

  // The guest is out of the meeting, and with it the board.
  await expect(guest.getByText("A moderator removed you from this meeting.")).toBeVisible();
  await expect(guest.locator(".tl-canvas")).toHaveCount(0);
  await expect(host.getByRole("button", { name: "Remove Bob Guest from meeting" })).toHaveCount(0);
  await expect(strokes(host)).toHaveCount(1);

  // The link no longer lets them back in.
  await guest.goto(link);
  await guest.getByRole("button", { name: "Join meeting" }).click({ timeout: 60_000 });
  await expect(guest.getByText("A moderator removed you from this meeting.")).toBeVisible();
  await expect(guest.getByRole("toolbar", { name: "Meeting controls" })).toHaveCount(0);
});

test("the board reconnects after the whiteboard server restarts", async ({ signUp }) => {
  const { host, guest } = await meetingWithBoard(signUp);
  await grantEditAccess(host, guest);
  await drawStroke(host, { x: -200, y: -60 });
  await expect(strokes(guest)).toHaveCount(1);

  await restartWhiteboardServer();

  // Both reconnect on their own: what was drawn before survives, and new
  // strokes from either side arrive at the other.
  await drawStroke(host, { x: 0, y: 0 });
  await expect(strokes(guest)).toHaveCount(2, { timeout: 45_000 });
  await drawStroke(guest, { x: 150, y: 80 });
  await expect(strokes(host)).toHaveCount(3);
  await expect(strokes(guest)).toHaveCount(3);
});

test("strokes survive layout changes, even mid-stroke", async ({ signUp }) => {
  const { host, guest } = await meetingWithBoard(signUp);

  // The window shrinks while a stroke is still being drawn.
  await drawStroke(host, { x: -200, y: -80 }, async () => {
    await host.setViewportSize({ width: 1024, height: 680 });
  });
  await expect(strokes(host)).toHaveCount(1);

  // The Conversation, open beside the board, closes and opens again between
  // strokes, the faces filling the column and making room under them.
  await host.getByRole("button", { name: "Close the side panel" }).click();
  await drawStroke(host, { x: -60, y: 0 });
  await host.getByRole("button", { name: /^Chat ·/ }).click();
  await drawStroke(host, { x: -40, y: 60 });
  await host.setViewportSize({ width: 1280, height: 720 });
  await drawStroke(host, { x: 60, y: 60 });

  await expect(strokes(host)).toHaveCount(4);
  await expect(strokes(guest)).toHaveCount(4);
  await expect(host.getByText("Whiteboard unavailable")).toHaveCount(0);
});

test("pages turn for everyone, and each person lands back on theirs after a restart", async ({ signUp }) => {
  const { host, guest } = await meetingWithBoard(signUp);
  await expect(pager(host)).toHaveAccessibleName(/^Page 1 of 1\./);

  // The host adds a page and everyone moves to it.
  await host.getByRole("button", { name: "New page after this one" }).click();
  await expect(pager(host)).toHaveAccessibleName(/^Page 2 of 2\./);
  await expect(pager(guest)).toHaveAccessibleName(/^Page 2 of 2\./);

  await host.getByRole("button", { name: "Previous page" }).click();
  await expect(pager(host)).toHaveAccessibleName(/^Page 1 of 2\./);
  await expect(pager(guest)).toHaveAccessibleName(/^Page 1 of 2\./);
  await host.getByRole("button", { name: "Next page" }).click();
  await expect(pager(guest)).toHaveAccessibleName(/^Page 2 of 2\./);

  await restartWhiteboardServer();

  // A stroke arriving proves both reconnected; neither was sent back to page 1.
  await drawStroke(host, { x: 0, y: 0 });
  await expect(strokes(guest)).toHaveCount(1, { timeout: 45_000 });
  await expect(pager(host)).toHaveAccessibleName(/^Page 2 of 2\./);
  await expect(pager(guest)).toHaveAccessibleName(/^Page 2 of 2\./);
});

test("anyone can ask for the board, and the host's yes opens it for everyone", async ({ signUp }) => {
  const host = await signUp("Alice Host");
  const link = await startMeeting(host);
  const guest = await signUp("Bob Guest");
  await joinMeeting(guest, link);

  // A no first: the ask is cleared and the guest is told.
  await guest.getByRole("button", { name: /Ask the host to open the board/ }).click();
  await host.getByRole("button", { name: "Deny opening the board for Bob Guest" }).click();
  await expect(guest.getByText("The board stays closed for now")).toBeVisible();

  // Then a yes: the board opens for the room.
  await guest.getByRole("button", { name: /Ask the host to open the board/ }).click();
  await host.getByRole("button", { name: "Approve opening the board for Bob Guest" }).click();
  await expect(host.getByRole("button", { name: "Draw", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(guest.getByRole("button", { name: "Ask to edit" })).toBeVisible({ timeout: 60_000 });
});

test("a follower scrolls with the host, and looks around on their own", async ({ signUp }) => {
  const { host, guest } = await meetingWithBoard(signUp);
  await host.getByRole("button", { name: "New page after this one" }).click();
  await host.getByRole("button", { name: "New page after this one" }).click();
  await expect(pager(guest)).toHaveAccessibleName(/^Page 3 of 3\./);

  // The host scrolls back up the stack; the guest is carried along.
  const canvas = await host.locator(".tl-canvas").boundingBox();
  if (!canvas) throw new Error("no canvas");
  await host.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  for (let step = 0; step < 12; step += 1) await host.mouse.wheel(0, -400);
  await expect(pager(host)).toHaveAccessibleName(/^Page 1 of 3\./);
  await expect(pager(guest)).toHaveAccessibleName(/^Page 1 of 3\./);

  // The guest scrolls on their own and stops following, with a way back.
  const guestCanvas = await guest.locator(".tl-canvas").boundingBox();
  if (!guestCanvas) throw new Error("no canvas");
  await guest.mouse.move(guestCanvas.x + guestCanvas.width / 2, guestCanvas.y + guestCanvas.height / 2);
  await guest.mouse.wheel(0, 600);
  await expect(guest.getByRole("button", { name: /Back to Alice Host/ }).first()).toBeVisible();
});

test("a follower who drags the view stays where they dragged it", async ({ signUp }) => {
  const { host, guest } = await meetingWithBoard(signUp);
  await host.getByRole("button", { name: "New page after this one" }).click();
  await host.getByRole("button", { name: "New page after this one" }).click();
  await expect(pager(guest)).toHaveAccessibleName(/^Page 3 of 3\./);
  await expect(guest.getByText("Following Alice Host")).toBeVisible();

  // Let the guest's view arrive at the host's before taking hold of it.
  const cameraY = () =>
    guest
      .locator(".tl-html-layer")
      .first()
      .evaluate((layer) => Number(/translate\([^,]+,\s*(-?[\d.]+)px\)/.exec((layer as HTMLElement).style.transform)?.[1]));
  let settled = 0;
  await expect(async () => {
    const before = await cameraY();
    await guest.waitForTimeout(400);
    settled = await cameraY();
    expect(settled).toBe(before);
  }).toPass();

  // A drag, not a scroll: the middle button pans the board as the hand tool does.
  const canvas = await guest.locator(".tl-canvas").boundingBox();
  if (!canvas) throw new Error("no canvas");
  await guest.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await guest.mouse.down({ button: "middle" });
  await guest.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2 + 300, { steps: 12 });
  await guest.mouse.up({ button: "middle" });
  await expect(guest.getByRole("button", { name: /Back to Alice Host/ }).first()).toBeVisible();

  // Following would ease the view back towards the host's the moment the hand
  // lifts. It may coast on in the drag's direction; it never goes back.
  const dragged = await cameraY();
  expect(dragged).toBeGreaterThan(settled + 200);
  await guest.waitForTimeout(1_000);
  expect(await cameraY()).toBeGreaterThanOrEqual(dragged);
});

test("the host lets everyone look around, then leads them again", async ({ signUp }) => {
  const { host, guest } = await meetingWithBoard(signUp);
  await host.getByRole("button", { name: "New page after this one" }).click();
  await host.getByRole("button", { name: "New page after this one" }).click();
  await expect(pager(guest)).toHaveAccessibleName(/^Page 3 of 3\./);
  await expect(host.getByRole("status").filter({ hasText: "You're presenting" })).toBeVisible();

  // Free roam: the host moves and the guest stays where they are.
  await host.getByRole("button", { name: "Let everyone browse" }).click();
  await expect(guest.getByText("Alice Host let everyone look around")).toBeVisible();
  await host.getByRole("button", { name: "Previous page" }).click();
  await expect(pager(host)).toHaveAccessibleName(/^Page 2 of 3\./);
  await expect(pager(guest)).toHaveAccessibleName(/^Page 3 of 3\./);

  // Leading again carries the guest to the host's page.
  await host.getByRole("button", { name: "Lead again" }).click();
  await expect(pager(guest)).toHaveAccessibleName(/^Page 2 of 3\./);
  await expect(guest.getByText("Following Alice Host")).toBeVisible();
});

test("a page is deleted from the page list", async ({ signUp }) => {
  const { host, guest } = await meetingWithBoard(signUp);
  await host.getByRole("button", { name: "New page after this one" }).click();
  await expect(pager(guest)).toHaveAccessibleName(/^Page 2 of 2\./);

  // Real clicks: the menu must be on top of the canvas, not clipped under it.
  await pager(host).click();
  await host.getByRole("button", { name: /^Page 2, current page\. Open page actions/ }).click();
  await host.getByRole("menuitem", { name: "Delete page" }).click();
  await host.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(pager(host)).toHaveAccessibleName(/^Page 1 of 1\./);
  await expect(pager(guest)).toHaveAccessibleName(/^Page 1 of 1\./);
});

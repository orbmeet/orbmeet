import type { Page } from "@playwright/test";
import { drawStroke, expect, meetingWithBoard, test } from "./support.ts";

/** The control bar's Chat toggle, named for what a press does. */
function conversationToggle(page: Page, open: boolean) {
  return page
    .getByRole("toolbar", { name: "Meeting controls" })
    .getByRole("button", { name: open ? "Close the chat" : /^Chat ·/ });
}

test("asking Orb in the room opens the Conversation for everyone", async ({ signUp }) => {
  const { host, guest } = await meetingWithBoard(signUp);
  if (await conversationToggle(guest, true).isVisible()) await conversationToggle(guest, true).click();
  await expect(conversationToggle(guest, false)).toBeVisible();

  if (await conversationToggle(host, false).isVisible()) await conversationToggle(host, false).click();
  const box = host.getByRole("textbox", { name: "Message everyone" });
  await box.fill("@Orb what is two plus two?");
  await box.press("Enter");

  await expect(conversationToggle(guest, true)).toBeVisible();
  await expect(guest.getByText("what is two plus two?")).toBeVisible();
});

test("Ask Orb is offered beside what you pick out, and not while you write", async ({ signUp }) => {
  const { host } = await meetingWithBoard(signUp);
  await drawStroke(host, { x: 80, y: 40 });
  const askOrb = host.getByRole("button", { name: "Ask Orb", exact: true });

  await host.getByRole("button", { name: "Select" }).click();
  const stroke = await host.locator('.tl-shape[data-shape-type="draw"]').first().boundingBox();
  if (!stroke) throw new Error("no stroke");
  await host.mouse.click(stroke.x + stroke.width / 2, stroke.y + stroke.height / 2);
  await expect(askOrb).toBeVisible();

  // The stroke stays selected under the pen; the offer does not stay beside it.
  await host.getByRole("button", { name: "Draw", exact: true }).click();
  await expect(askOrb).toHaveCount(0);
  await drawStroke(host, { x: -160, y: -80 });
  await expect(askOrb).toHaveCount(0);
});

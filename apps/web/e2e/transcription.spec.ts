import type { Page } from "@playwright/test";
import { expect, joinMeeting, startMeeting, test } from "./support.ts";

/** The top bar's "Transcribing" fact, which everyone in the meeting sees. */
function transcribingFact(page: Page) {
  return page.getByText("Transcribing", { exact: true });
}

async function openPeople(page: Page) {
  await page.getByRole("button", { name: /^People/ }).first().click();
}

test("an attendee asks to stop transcription, and a host turns it off and on for everyone", async ({ signUp }) => {
  const host = await signUp("Alice Host");
  const link = await startMeeting(host);
  const guest = await signUp("Bob Guest");
  await joinMeeting(guest, link);

  // Everyone can see it is on: it is about what they say.
  await expect(transcribingFact(host)).toBeVisible({ timeout: 30_000 });
  await expect(transcribingFact(guest)).toBeVisible({ timeout: 30_000 });

  // An attendee has no switch, only the ask.
  await openPeople(guest);
  await expect(guest.getByRole("switch", { name: "Transcribe this meeting" })).toHaveCount(0);
  await guest.getByRole("button", { name: "Ask to stop" }).click();
  await expect(guest.getByText("You asked a host to turn it off.")).toBeVisible();

  // The host answers it from the request tray, which turns it off for everyone.
  await host.getByRole("button", { name: "Approve stopping transcription for Bob Guest" }).click({ timeout: 30_000 });
  await expect(transcribingFact(host)).toHaveCount(0, { timeout: 30_000 });
  await expect(transcribingFact(guest)).toHaveCount(0, { timeout: 30_000 });
  await expect(guest.getByText("Transcription is off").first()).toBeVisible();
  await expect(guest.getByRole("button", { name: "Ask to stop" })).toHaveCount(0);

  // The host turns it back on with the switch in People.
  await openPeople(host);
  const hostSwitch = host.getByRole("switch", { name: "Transcribe this meeting" });
  await expect(hostSwitch).toHaveAttribute("aria-checked", "false");
  await hostSwitch.click();
  await expect(hostSwitch).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await expect(transcribingFact(guest)).toBeVisible({ timeout: 30_000 });
  await expect(guest.getByText("Transcription is on").first()).toBeVisible();
});

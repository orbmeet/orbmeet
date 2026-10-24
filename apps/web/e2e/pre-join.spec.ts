import type { Page } from "@playwright/test";
import { expect, joinFromPreJoin, startMeeting, test } from "./support.ts";

/** How many of the page's videos are showing frames. */
function playingVideos(page: Page) {
  return page.locator("video").evaluateAll(
    (videos) => (videos as HTMLVideoElement[]).filter((video) => video.readyState >= 2 && video.videoWidth > 0).length,
  );
}

test("joining from the pre-join screen with fake devices", async ({ signUp }) => {
  const host = await signUp("Alice Host");
  const link = await startMeeting(host);

  const guest = await signUp("Bob Guest");
  await guest.goto(link);

  // The pre-join screen finds the fake devices and previews the camera.
  await expect(guest.getByRole("button", { name: /fake_device_0/ })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => playingVideos(guest)).toBeGreaterThan(0);

  // The camera can be turned off and on again before joining.
  await guest.getByRole("button", { name: "Turn off camera" }).click();
  await expect.poll(() => playingVideos(guest)).toBe(0);
  await guest.getByRole("button", { name: "Turn on camera" }).click();
  await expect.poll(() => playingVideos(guest)).toBeGreaterThan(0);

  await joinFromPreJoin(guest);

  // Each side sees its own camera and the other's.
  await expect.poll(() => playingVideos(host), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => playingVideos(guest), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
});

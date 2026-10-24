import type { Page } from "@playwright/test";
import { expect, joinMeeting, startMeeting, test } from "./support.ts";

const STOPPED = "Your microphone stopped";

/**
 * Keeps every peer connection the page makes, so a test can do to the
 * microphone's sender what an iPadOS call does: stop it sending, while the
 * track, the publication and the mute button all still say "on".
 */
function captureSenders() {
  const Native = window.RTCPeerConnection;
  const connections: RTCPeerConnection[] = [];
  (window as unknown as { __peerConnections: RTCPeerConnection[] }).__peerConnections = connections;
  window.RTCPeerConnection = class extends Native {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      connections.push(this);
    }
  };
}

/** Stops the microphone's sender without telling anyone; returns how many it stopped. */
function stopMicrophoneSending(page: Page) {
  return page.evaluate(async () => {
    const connections = (window as unknown as { __peerConnections: RTCPeerConnection[] }).__peerConnections;
    let stopped = 0;
    for (const connection of connections) {
      for (const sender of connection.getSenders()) {
        if (sender.track?.kind !== "audio") continue;
        await sender.replaceTrack(null);
        stopped += 1;
      }
    }
    return stopped;
  });
}

/** Whether the microphone's sender has a track to send again. */
function microphoneSending(page: Page) {
  return page.evaluate(() => {
    const connections = (window as unknown as { __peerConnections: RTCPeerConnection[] }).__peerConnections;
    return connections.some((connection) =>
      connection.getSenders().some((sender) => sender.track?.kind === "audio" && sender.track.readyState === "live"));
  });
}

test("a microphone that stops sending is noticed, said, and brought back", async ({ signUp }) => {
  const host = await signUp("Alice Host");
  const link = await startMeeting(host);

  const guest = await signUp("Bob Guest");
  await guest.addInitScript(captureSenders);
  await joinMeeting(guest, link);

  // A healthy microphone raises no alarm across several samples.
  await expect.poll(() => microphoneSending(guest), { timeout: 30_000 }).toBe(true);
  await guest.waitForTimeout(15_000);
  await expect(guest.getByText(STOPPED, { exact: true })).toHaveCount(0);

  // The capture stops sending, as it does when a call takes the iPad's audio.
  expect(await stopMicrophoneSending(guest)).toBeGreaterThan(0);
  await expect(guest.getByText(STOPPED, { exact: true })).toBeVisible({ timeout: 30_000 });

  // Recovery restarts the capture on its own and takes the notice down once
  // packets flow again.
  await expect.poll(() => microphoneSending(guest), { timeout: 30_000 }).toBe(true);
  await expect(guest.getByText(STOPPED, { exact: true })).toHaveCount(0, { timeout: 30_000 });
});

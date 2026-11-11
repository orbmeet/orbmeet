import { expect, it, vi } from "vitest";
import { WhiteboardCredentials } from "./whiteboard-credentials";

const CONNECTION = "connection-1";
const HOUR_MS = 3_600_000;
const JOINED_AT = 1_800_000_000_000;

/** A join's whiteboard token, good for an hour. */
function joinToken(): string {
  const iat = Math.floor(JOINED_AT / 1000);
  const payload = { iat, exp: iat + 3600, connectionId: CONNECTION, documentId: "wb_1" };
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function credentialsBuiltAt(now: number) {
  return new WhiteboardCredentials({
    connectionId: CONNECTION,
    initial: {
      token: joinToken(),
      url: "https://whiteboard.example",
      documentId: "wb_1",
      documentTitle: null,
      receivedAt: JOINED_AT,
    },
    mint: vi.fn(),
    onChange: () => {},
    now: () => now,
  });
}

const surface = { whiteboardId: "wb_1", revision: 0 };

it("ages the join's token from when the join arrived, not from when it is built", () => {
  // Built an hour after the join, as a "Reload view" remount does.
  const late = credentialsBuiltAt(JOINED_AT + HOUR_MS);
  expect(late.isUsableFor(surface)).toBe(false);
  expect(late.refreshAt).toBeLessThan(JOINED_AT + HOUR_MS);

  const prompt = credentialsBuiltAt(JOINED_AT + 1_000);
  expect(prompt.isUsableFor(surface)).toBe(true);
});

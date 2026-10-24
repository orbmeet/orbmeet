import { describe, expect, it } from "vitest";
import { whiteboardCspDomains } from "./csp";

describe("whiteboardCspDomains", () => {
  it("admits every node's sync server under the app's domain", () => {
    expect(whiteboardCspDomains("https://orbmeet.com")).toEqual(["*.whiteboard.orbmeet.com"]);
    expect(whiteboardCspDomains("https://Orbmeet.com/")).toEqual(["*.whiteboard.orbmeet.com"]);
  });

  it.each([undefined, "", "http://localhost:3000", "http://127.0.0.1:3000", "orbmeet.com", "not a url"])(
    "admits nothing for %j",
    (appUrl) => {
      expect(whiteboardCspDomains(appUrl)).toEqual([]);
    },
  );
});

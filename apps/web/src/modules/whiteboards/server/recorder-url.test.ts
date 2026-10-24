import { describe, expect, it } from "vitest";
import { buildRecorderUrl } from "./recorder-url";

function parseRecorderHashParams(hashValue: string, searchValue = ""): URLSearchParams {
  const params = new URLSearchParams(
    searchValue.startsWith("?") ? searchValue.slice(1) : searchValue,
  );
  const hash = hashValue.startsWith("#") ? hashValue.slice(1) : hashValue;
  const questionIndex = hash.indexOf("?");
  const normalized =
    questionIndex === -1
      ? hash
      : `${hash.slice(0, questionIndex)}&${hash.slice(questionIndex + 1)}`;
  const hashParams = new URLSearchParams(normalized);
  hashParams.forEach((value, key) => params.set(key, value));
  return params;
}

describe("recorder URL token placement", () => {
  it("places app-owned recorder parameters in the hash fragment", () => {
    const url = buildRecorderUrl(
      "https://app.orbmeet.com",
      "https://whiteboard.orbmeet.com",
      "secret-token",
      { egressMode: "streaming", meetingCode: "abc-defg-hij" },
    );
    const parsed = new URL(url);

    expect(parsed.search).toBe("");
    const hashParams = parseRecorderHashParams(parsed.hash);
    expect(hashParams.get("wb_url")).toBe("https://whiteboard.orbmeet.com");
    expect(hashParams.get("wb_recorder_token")).toBe("secret-token");
    expect(hashParams.get("meeting_code")).toBe("abc-defg-hij");
    expect(hashParams.get("egress_mode")).toBe("streaming");
  });

  it("allows LiveKit to append ?url=&token= after the hash", () => {
    const base = buildRecorderUrl(
      "https://app.orbmeet.com",
      "https://whiteboard.orbmeet.com",
      "secret-token",
      { egressMode: "streaming" },
    );
    // LiveKit room composite egress appends ?url=...&token=... to the customBaseUrl
    const url = `${base}?url=wss%3A%2F%2Flivekit.orbmeet.com&token=livekit-token`;

    // The ?url=... lands inside the hash fragment (after #), not as a real query param.
    // parseRecorderHashParams normalizes ? to & so all params are accessible.
    const parsed = new URL(url);
    expect(parsed.search).toBe("");

    const hashParams = parseRecorderHashParams(parsed.hash);
    expect(hashParams.get("wb_url")).toBe("https://whiteboard.orbmeet.com");
    expect(hashParams.get("wb_recorder_token")).toBe("secret-token");
    expect(hashParams.get("egress_mode")).toBe("streaming");
    expect(hashParams.get("url")).toBe("wss://livekit.orbmeet.com");
    expect(hashParams.get("token")).toBe("livekit-token");
  });

  it("allows LiveKit to append ?url=&token= before the hash", () => {
    const base = buildRecorderUrl(
      "https://app.orbmeet.com",
      "https://whiteboard.orbmeet.com",
      "secret-token",
      { egressMode: "streaming" },
    );
    const parsedBase = new URL(base);
    const url = `${parsedBase.origin}${parsedBase.pathname}?url=wss%3A%2F%2Flivekit.orbmeet.com&token=livekit-token${parsedBase.hash}`;
    const parsed = new URL(url);

    const hashParams = parseRecorderHashParams(parsed.hash, parsed.search);
    expect(hashParams.get("wb_url")).toBe("https://whiteboard.orbmeet.com");
    expect(hashParams.get("wb_recorder_token")).toBe("secret-token");
    expect(hashParams.get("egress_mode")).toBe("streaming");
    expect(hashParams.get("url")).toBe("wss://livekit.orbmeet.com");
    expect(hashParams.get("token")).toBe("livekit-token");
  });

  it("can include explicit LiveKit recorder params", () => {
    const url = buildRecorderUrl(
      "https://app.orbmeet.com",
      "https://whiteboard.orbmeet.com",
      "whiteboard-token",
      {
        livekitUrl: "wss://livekit.orbmeet.com",
        livekitToken: "livekit-token",
        egressMode: "streaming",
      },
    );
    const parsed = new URL(url);

    expect(parsed.search).toBe("");
    const hashParams = parseRecorderHashParams(parsed.hash);
    expect(hashParams.get("url")).toBe("wss://livekit.orbmeet.com");
    expect(hashParams.get("token")).toBe("livekit-token");
    expect(hashParams.get("wb_recorder_token")).toBe("whiteboard-token");
    expect(hashParams.get("egress_mode")).toBe("streaming");
  });
});

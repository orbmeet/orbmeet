import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentConfig } from "./config.js";

function stubAgentEnvironment(overrides: Record<string, string> = {}): void {
  const settings: Record<string, string> = {
    APP_URL: "https://app.example.com/",
    TRANSCRIPTION_INTERNAL_KEY_ID: "agent-primary",
    TRANSCRIPTION_INTERNAL_SECRET: "s".repeat(32),
    LIVEKIT_URL: "wss://livekit.example.com",
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
    DEEPGRAM_API_KEY: "deepgram",
    ...overrides,
  };
  for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
}

describe("loadAgentConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads numeric settings from plain digits only", () => {
    stubAgentEnvironment({ TRANSCRIPTION_MAX_ACTIVE_JOBS: "12" });
    expect(loadAgentConfig().maxActiveJobs).toBe(12);

    stubAgentEnvironment({ TRANSCRIPTION_MAX_ACTIVE_JOBS: "1e1" });
    expect(() => loadAgentConfig()).toThrow("maxActiveJobs");
  });

  it("reads the ingest endpoint without a trailing slash and refuses a short secret", () => {
    stubAgentEnvironment();
    expect(loadAgentConfig().appUrl).toBe("https://app.example.com");

    stubAgentEnvironment({ TRANSCRIPTION_INTERNAL_SECRET: "short" });
    expect(() => loadAgentConfig()).toThrow("internalSecret");
  });

  it("accepts plain HTTP only for a dev server on this machine", () => {
    stubAgentEnvironment({ APP_URL: "http://localhost:3000" });
    expect(loadAgentConfig().appUrl).toBe("http://localhost:3000");

    stubAgentEnvironment({ APP_URL: "http://app.example.com" });
    expect(() => loadAgentConfig()).toThrow("appUrl");
  });

  it("accepts plain ws:// LiveKit only on this machine or its private bridge", () => {
    stubAgentEnvironment({ LIVEKIT_URL: "ws://127.0.0.1:27880" });
    expect(loadAgentConfig().livekitUrl).toBe("ws://127.0.0.1:27880");
    stubAgentEnvironment({ LIVEKIT_URL: "ws://172.30.22.1:7880" });
    expect(loadAgentConfig().livekitUrl).toBe("ws://172.30.22.1:7880");

    stubAgentEnvironment({ LIVEKIT_URL: "ws://203.0.113.10:7880" });
    expect(() => loadAgentConfig()).toThrow("livekitUrl");
    stubAgentEnvironment({ LIVEKIT_URL: "ws://172.32.0.1:7880" });
    expect(() => loadAgentConfig()).toThrow("livekitUrl");

    stubAgentEnvironment({ LIVEKIT_URL: "ws://livekit.example.com" });
    expect(() => loadAgentConfig()).toThrow("livekitUrl");

    stubAgentEnvironment({ LIVEKIT_URL: "ws://localhost.example.com" });
    expect(() => loadAgentConfig()).toThrow("livekitUrl");
  });
});

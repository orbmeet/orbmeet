import { describe, expect, it } from "vitest";
import {
  checkRequestOrigin,
  trustedProxyConfigurationWarning,
  readAssistantModelConfig,
} from "./config.ts";

describe("checkRequestOrigin", () => {
  const configured = {
    allowedOrigins: ["https://app.example"],
    allowInsecureAllOrigins: false,
  };

  it("admits a configured origin and refuses any other", () => {
    expect(checkRequestOrigin("https://app.example", configured)).toBeNull();
    expect(checkRequestOrigin("https://evil.example", configured)).toBe("forbidden origin");
  });

  it("refuses a missing origin rather than exempting it", () => {
    // The absent header is the one request shape a non-browser client fully
    // controls, so treating it as "nothing to check" would make the check a
    // no-op for exactly the caller it is meant to stop.
    expect(checkRequestOrigin(null, configured)).toBe("missing origin");
    expect(checkRequestOrigin("", configured)).toBe("missing origin");
    expect(
      checkRequestOrigin(null, { allowedOrigins: [], allowInsecureAllOrigins: true }),
    ).toBe("missing origin");
  });

  it("refuses everything when no origins are configured and the insecure opt-out is off", () => {
    const unconfigured = { allowedOrigins: [], allowInsecureAllOrigins: false };
    expect(checkRequestOrigin("https://app.example", unconfigured)).toBe(
      "no allowed origins configured",
    );
  });

  it("admits any present origin under the development opt-out", () => {
    const permissive = { allowedOrigins: [], allowInsecureAllOrigins: true };
    expect(checkRequestOrigin("http://localhost:3000", permissive)).toBeNull();
  });
});

describe("trustedProxyConfigurationWarning", () => {
  it("warns only for a non-local deployment with no trusted proxies", () => {
    expect(trustedProxyConfigurationWarning("https://app.example", 0)).toMatch(
      /TRUST_PROXY_IPS/,
    );
    expect(trustedProxyConfigurationWarning("https://app.example", 1)).toBeNull();
    expect(trustedProxyConfigurationWarning("http://localhost:3000", 0)).toBeNull();
  });
});

describe("readAssistantModelConfig", () => {
  it("is off when neither variable is set", () => {
    expect(readAssistantModelConfig("", "")).toBeNull();
  });

  it("splits the provider from the model id", () => {
    expect(readAssistantModelConfig("google/gemini-3.8-flash", "key")).toEqual({
      provider: "google",
      modelId: "gemini-3.8-flash",
      apiKey: "key",
    });
    expect(readAssistantModelConfig("anthropic/claude-sonnet-5-5", "key")).toMatchObject({ provider: "anthropic" });
  });

  it("refuses half a configuration or an unknown provider", () => {
    expect(readAssistantModelConfig("google/gemini-3.8-flash", "")).toBeTypeOf("string");
    expect(readAssistantModelConfig("", "key")).toBeTypeOf("string");
    expect(readAssistantModelConfig("gemini-3.8-flash", "key")).toBeTypeOf("string");
    expect(readAssistantModelConfig("openai/gpt-6", "key")).toBeTypeOf("string");
    expect(readAssistantModelConfig("google/", "key")).toBeTypeOf("string");
  });
});

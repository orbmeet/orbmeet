import { describe, expect, it } from "vitest";
import { createAssistantModel } from "./assistant-model.ts";

describe("createAssistantModel", () => {
  it("resolves a model from pi's catalog", () => {
    expect(createAssistantModel({ provider: "google", modelId: "gemini-3.8-flash", apiKey: "key" }).model).toMatchObject({
      provider: "google",
      id: "gemini-3.8-flash",
    });
    expect(createAssistantModel({ provider: "anthropic", modelId: "claude-sonnet-5-5", apiKey: "key" }).model).toMatchObject({
      provider: "anthropic",
    });
  });

  it("fails at startup on a model the provider does not have", () => {
    expect(() => createAssistantModel({ provider: "google", modelId: "gemini-0", apiKey: "key" })).toThrow(/unknown model/);
  });
});

import { describe, expect, it } from "vitest";
import { reusableLinkCreationInput } from "./reusable-link-input";

describe("reusableLinkCreationInput", () => {
  it("lets the server assign Free-plan codes", () => {
    expect(reusableLinkCreationInput("free", "abc-defg-hij")).toEqual({
      allowGuests: true,
      joinPolicy: "open",
      linkType: "reusable",
    });
  });

  it("sends a chosen code when the plan permits customization", () => {
    expect(reusableLinkCreationInput("pro", "abc-defg-hij")).toMatchObject({
      customCode: "abc-defg-hij",
    });
  });
});

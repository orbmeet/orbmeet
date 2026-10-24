import { describe, expect, it } from "vitest";
import { revisionAssetUrl } from "./revision-asset-url";

describe("revisionAssetUrl", () => {
  it("scopes an inherited asset to the board showing the revision (WB-07)", () => {
    // Board B, copied from A, still shows an image A owns.
    expect(
      revisionAssetUrl("whiteboards/A/assets/image.png", { whiteboardId: "B", revisionId: "B-revision" }),
    ).toBe("/api/wb-assets/whiteboards/A/assets/image.png?whiteboardId=B&revisionId=B-revision");
  });

  it("refuses a source on another origin", () => {
    expect(revisionAssetUrl("//example.invalid/pixel", { whiteboardId: "B", revisionId: "r" })).toBeNull();
    expect(revisionAssetUrl("https://example.invalid/pixel", null)).toBeNull();
  });
});

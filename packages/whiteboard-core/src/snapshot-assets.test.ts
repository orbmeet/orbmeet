import { describe, expect, it } from "vitest";
import { extractSnapshotAssetKeys } from "./snapshot-assets.ts";

describe("extractSnapshotAssetKeys", () => {
  it("collects and sorts document asset keys without duplicates", () => {
    const first = "whiteboards/board_1/assets/asset_b.png";
    const second = "whiteboards/board_1/assets/asset_a.pdf";
    const snapshot = {
      documents: [
        { state: { typeName: "asset", props: { src: first } } },
        { state: { typeName: "asset", props: { src: `/api/wb-assets/${second}` } } },
        { state: { typeName: "asset", props: { src: first } } },
      ],
    };

    expect(extractSnapshotAssetKeys(snapshot)).toEqual([second, first]);
  });

  it("does not treat arbitrary shape text or snapshot metadata as an asset reference", () => {
    const key = "whiteboards/board_victim/assets/secret.png";
    const snapshot = {
      metadata: key,
      documents: [{
        state: {
          typeName: "shape",
          props: { text: key, nested: { src: key } },
        },
      }],
    };

    expect(extractSnapshotAssetKeys(snapshot)).toEqual([]);
  });

  it("treats malformed snapshots as having no assets", () => {
    expect(extractSnapshotAssetKeys("{")).toEqual([]);
    expect(extractSnapshotAssetKeys(null)).toEqual([]);
  });

  it("pins nothing for a source no viewer would load", () => {
    const snapshot = {
      documents: [
        { state: { typeName: "asset", props: { src: "whiteboards/board_1/assets/a.png?v=1" } } },
        { state: { typeName: "asset", props: { src: "whiteboards%2Fboard_1%2Fassets%2Fa.png" } } },
        { state: { typeName: "asset", props: { src: "/api/wb-assets/whiteboards/board_1/assets/b.png#x" } } },
      ],
    };
    expect(extractSnapshotAssetKeys(snapshot)).toEqual([]);
  });
});

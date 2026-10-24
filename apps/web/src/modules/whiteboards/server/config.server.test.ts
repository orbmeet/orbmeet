import { describe, expect, it } from "vitest";
import { isWhiteboardConfigured, whiteboardNodes } from "@/modules/whiteboards/server/config.server";
import { TEST_WHITEBOARD_ENV } from "@/test/fake-sync-server";
import { TEST_MEDIA_ENV } from "@/test/nodes";

describe("whiteboardNodes", () => {
  it("lists the nodes that run a whiteboard, and none when NODES is unusable", () => {
    expect(whiteboardNodes(TEST_WHITEBOARD_ENV).map((node) => [node.id, node.whiteboardUrl]))
      .toEqual([["test-node", "https://whiteboard.test"]]);
    expect(whiteboardNodes(TEST_MEDIA_ENV)).toEqual([]);
    expect(whiteboardNodes({ NODES: "" })).toEqual([]);
  });

  it("makes boards usable exactly when some node runs a whiteboard", () => {
    expect(isWhiteboardConfigured(TEST_WHITEBOARD_ENV)).toBe(true);
    expect(isWhiteboardConfigured(TEST_MEDIA_ENV)).toBe(false);
    expect(isWhiteboardConfigured({} as Env)).toBe(false);
  });
});

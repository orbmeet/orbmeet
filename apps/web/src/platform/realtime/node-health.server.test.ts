import { afterEach, describe, expect, it, vi } from "vitest";
import { SYNC_PROTOCOL } from "@orbmeet/whiteboard-core/sync-commands";
import type { WhiteboardNode } from "./nodes";

vi.mock("@/lib/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("./livekit-clients.server", () => ({ createRoomServiceClient: vi.fn() }));

const { probeWhiteboardNode } = await import("./node-health.server");

const node = { id: "sg1", whiteboardUrl: "https://sg1.wb.example" } as WhiteboardNode;

function answering(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeWhiteboardNode", () => {
  it("is healthy when the node speaks this Worker's protocol", async () => {
    answering({ ok: true, protocol: SYNC_PROTOCOL });
    await expect(probeWhiteboardNode(node)).resolves.toBe(true);
  });

  it("reads a node from before protocols as speaking the first", async () => {
    answering({ ok: true });
    await expect(probeWhiteboardNode(node)).resolves.toBe(SYNC_PROTOCOL.accepts.oldest === 1);
  });

  it("is not healthy when the node cannot read what this Worker speaks", async () => {
    const newer = SYNC_PROTOCOL.accepts.newest + 1;
    answering({ ok: true, protocol: { speaks: newer, accepts: { oldest: newer, newest: newer } } });
    await expect(probeWhiteboardNode(node)).resolves.toBe(false);
  });

  it("is not healthy when the node is not answering", async () => {
    answering({ ok: false }, 503);
    await expect(probeWhiteboardNode(node)).resolves.toBe(false);
  });
});

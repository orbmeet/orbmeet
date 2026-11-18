// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAssistant, type Assistant, type UseAssistantOptions } from "./use-assistant";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const channel = { on: () => () => {} } as unknown as UseAssistantOptions["channel"];
const tokenRef = { current: "token" };
const pageManagerRef = { current: null };

let root: Root;
let latest: Assistant | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

function Harness({ syncOnline }: { syncOnline: boolean }) {
  latest = useAssistant({
    channel,
    enabled: true,
    whiteboardUrl: "https://wb.example",
    tokenRef,
    participant: "user:alice",
    editor: null,
    pageManagerRef,
    canManageWhiteboard: false,
    syncOnline,
  });
  return null;
}

async function render(syncOnline: boolean) {
  await act(async () => root.render(<Harness syncOnline={syncOnline} />));
}

function snapshot(runs: unknown[]) {
  return new Response(JSON.stringify({ available: true, entries: [], runs }), { status: 200 });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  latest = null;
});

describe("useAssistant", () => {
  it("reloads the conversation each time the socket comes back online", async () => {
    const run = { id: "r1", requesterUserId: "alice", requesterName: "Alice", startedAt: 1 };
    fetchMock.mockResolvedValueOnce(snapshot([run])).mockResolvedValueOnce(snapshot([]));

    await render(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(latest?.runs).toHaveLength(1);

    // The run ends while the socket is down: its live event never arrives.
    await render(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await render(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.runs).toHaveLength(0);
  });
});

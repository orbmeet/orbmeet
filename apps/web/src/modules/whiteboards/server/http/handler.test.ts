import { CODE_RUN_PATH } from "@orbmeet/whiteboard-core/code-run-contract";
import { ROOM_AUTHORITY_PATH, SYNC_PROTOCOL, SYNC_PROTOCOL_HEADER } from "@orbmeet/whiteboard-core/sync-commands";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlePdfUploadMock = vi.fn();
const handleRecorderAuthMock = vi.fn();
const handleWbAssetsMock = vi.fn();
const handleRunCodeMock = vi.fn();
const handleRoomAuthorityMock = vi.fn();

vi.mock("@/modules/whiteboards/server/http/whiteboard-pdf-upload", () => ({ handlePdfUpload: handlePdfUploadMock }));
vi.mock("@/modules/whiteboards/server/http/recorder-auth", () => ({ handleRecorderAuth: handleRecorderAuthMock }));
vi.mock("@/modules/whiteboards/server/http/wb-assets", () => ({ handleWbAssets: handleWbAssetsMock }));
vi.mock("@/modules/whiteboards/server/http/room-authority", () => ({ handleRoomAuthority: handleRoomAuthorityMock }));
vi.mock("@/modules/whiteboards/server/http/run-code", () => ({
  handleRunCode: handleRunCodeMock,
  handleCancelCodeRun: vi.fn(),
}));

const { whiteboardFetchHandler } = await import("./handler");

const env = { APP_URL: "https://app.example", ENVIRONMENT: "production" } as Env;

function request(path: string, method: string, origin?: string) {
  return new Request(`https://app.example${path}`, {
    method,
    headers: origin ? { Origin: origin } : {},
  });
}

describe("whiteboardFetchHandler", () => {
  beforeEach(() => {
    for (const mock of [handlePdfUploadMock, handleRecorderAuthMock, handleWbAssetsMock, handleRunCodeMock, handleRoomAuthorityMock]) {
      mock.mockReset().mockResolvedValue(new Response("ok"));
    }
  });

  it.each([
    ["/api/whiteboard/pdf-upload", handlePdfUploadMock],
    ["/api/whiteboard/recorder-auth", handleRecorderAuthMock],
  ])("refuses a browser POST to %s from another site", async (path, handle) => {
    const response = await whiteboardFetchHandler(request(path, "POST", "https://evil.example"), env, path);

    expect(response?.status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
  });

  it("hands a sync server's call on only when it speaks a protocol this Worker reads", async () => {
    const call = (headers: Record<string, string>) =>
      whiteboardFetchHandler(new Request(`https://app.example${ROOM_AUTHORITY_PATH}`, { method: "POST", headers }), env, ROOM_AUTHORITY_PATH);

    const newer = await call({ [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL.accepts.newest + 1) });
    expect(newer?.status).toBe(426);
    expect(await newer?.json()).toMatchObject({ ok: false, reason: "incompatible" });
    expect(handleRoomAuthorityMock).not.toHaveBeenCalled();

    expect((await call({ [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL.speaks) }))?.status).toBe(200);
    // A sync server from before the header speaks the first version.
    expect((await call({}))?.status).toBe(200);
  });

  it("passes a browser POST from the app's own origin", async () => {
    const path = "/api/whiteboard/pdf-upload";
    const response = await whiteboardFetchHandler(request(path, "POST", "https://app.example"), env, path);

    expect(response?.status).toBe(200);
    expect(handlePdfUploadMock).toHaveBeenCalledOnce();
  });

  it("serves a browser GET without an origin, handing the asset path on", async () => {
    const path = "/api/wb-assets/board/image.png";
    const response = await whiteboardFetchHandler(request(path, "GET"), env, path);

    expect(response?.status).toBe(200);
    expect(handleWbAssetsMock).toHaveBeenCalledWith(expect.any(Request), env, "board/image.png");
  });

  it("leaves bearer routes to their own authentication", async () => {
    await whiteboardFetchHandler(request(CODE_RUN_PATH, "POST", "https://elsewhere.example"), env, CODE_RUN_PATH);

    expect(handleRunCodeMock).toHaveBeenCalledOnce();
  });

  it("answers null for a path it does not own, or a method its route does not take", async () => {
    expect(await whiteboardFetchHandler(request("/api/other", "POST"), env, "/api/other")).toBeNull();
    expect(await whiteboardFetchHandler(
      request("/api/whiteboard/pdf-upload", "GET"), env, "/api/whiteboard/pdf-upload",
    )).toBeNull();
  });
});

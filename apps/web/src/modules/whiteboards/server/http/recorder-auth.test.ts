import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecorderBootstrapToken } from "@/modules/whiteboards/server/recorder-bootstrap-token";
import { createWhiteboardJWT, verifyWhiteboardJWT } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import { TEST_JWT_KEYRING, TEST_WHITEBOARD_ENV } from "@/test/fake-sync-server";

const createDbMock = vi.fn();
const canAccessWhiteboardAsRecorderMock = vi.fn();
const findMeetingWhiteboardDocumentMock = vi.fn();

class RequestBodyTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`Request body exceeds ${limitBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

vi.mock("@orbmeet/db", () => ({
  createDb: createDbMock,
}));

vi.mock("@/platform/http/request-body", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/http/request-body")>()),
  RequestBodyTooLargeError,
  readRequestBodyText: async (request: Request, maxBytes: number) => {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new RequestBodyTooLargeError(maxBytes);
    }
    return text;
  },
}));

vi.mock("@/platform/http/cookies.server", async () => {
  const { storedCookieName } = await import("@/platform/http/cookie-names");
  return {
    createCookieString: (
      name: string,
      value: string,
      maxAge: number,
      options?: { appUrl?: string; environment?: string; path?: string },
    ) => `${storedCookieName(name, options)}=${value}; Path=${options?.path ?? "/"}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
  };
});

vi.mock("@/modules/whiteboards/server/meeting/access", () => ({
  canAccessWhiteboardAsRecorder: canAccessWhiteboardAsRecorderMock,
}));

vi.mock("@/modules/whiteboards/server/documents", () => ({
  findMeetingWhiteboardDocument: findMeetingWhiteboardDocumentMock,
}));

// The board is wherever D1 says (board-placement.d1.test.ts): here, on sg1 at generation 3.
vi.mock("@/modules/whiteboards/server/board-placement.server", () => ({
  placeBoard: async () => ({
    node: { id: "sg1", whiteboardUrl: "https://sg1.whiteboard.example", jwtKeyring: TEST_JWT_KEYRING },
    generation: 3,
  }),
}));

const AUTH_SECRET = "test-auth-secret-at-least-32-chars-long!!";
const MEETING_ID = "mtg_123";

function presentedBoard(whiteboardId: string) {
  return { whiteboardId, syncRoomId: whiteboardId, status: "active" };
}

function env(): Env {
  return {
    APP_URL: "https://app.example",
    DB: {},
    ENVIRONMENT: "production",
    AUTH_SECRET,
    ...TEST_WHITEBOARD_ENV,
  } as unknown as Env;
}

function recorderAuthRequest(body: unknown, headers: HeadersInit = {}): Request {
  const requestHeaders = new Headers({
    "Content-Type": "application/json",
    Origin: "https://app.example",
  });
  new Headers(headers).forEach((value, key) => {
    requestHeaders.set(key, value);
  });

  return new Request("https://app.example/api/whiteboard/recorder-auth", {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

describe("handleRecorderAuth", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("exchanges a recorder bootstrap credential for a short-lived service token and asset cookie", async () => {
    const { handleRecorderAuth } = await import("@/modules/whiteboards/server/http/recorder-auth");
    const db = {};
    createDbMock.mockReturnValue(db);
    findMeetingWhiteboardDocumentMock.mockResolvedValue(presentedBoard("whiteboard_123"));
    canAccessWhiteboardAsRecorderMock.mockResolvedValue(true);
    const recorderToken = await createRecorderBootstrapToken({ AUTH_SECRET }, MEETING_ID);

    const response = await handleRecorderAuth(recorderAuthRequest({ recorderToken }), env());

    expect(response.status).toBe(200);
    expect(canAccessWhiteboardAsRecorderMock).toHaveBeenCalledWith(db, "mtg_123");
    const payload = await response.json() as {
      token: string;
      whiteboardUrl: string;
      documentId: string;
      expiresIn: number;
    };
    expect(payload.whiteboardUrl).toBe("https://sg1.whiteboard.example");
    expect(payload.documentId).toBe("whiteboard_123");
    expect(payload.expiresIn).toBe(3600);
    const claims = await verifyWhiteboardJWT(payload.token, TEST_JWT_KEYRING);
    expect(claims).toMatchObject({
      sub: "recorder",
      role: "guest",
      sid: "meet-whiteboard_123",
      connectionId: "recorder",
      service: "recorder",
      documentId: "whiteboard_123",
      generation: 3,
    });
    expect(response.headers.get("Set-Cookie")).toContain("__Secure-wb_asset_mtg_123=");
    expect(response.headers.get("Set-Cookie")).toContain("__Secure-wb_asset_whiteboard_123=");
    expect(response.headers.get("Set-Cookie")).toContain("Path=/api/wb-assets/");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
  });

  it("rejects recorder service JWTs as bootstrap credentials", async () => {
    const { handleRecorderAuth } = await import("@/modules/whiteboards/server/http/recorder-auth");
    createDbMock.mockReturnValue({});
    findMeetingWhiteboardDocumentMock.mockResolvedValue(presentedBoard("whiteboard_123"));
    canAccessWhiteboardAsRecorderMock.mockResolvedValue(true);
    const recorderToken = await createWhiteboardJWT(TEST_JWT_KEYRING, {
      sub: "recorder",
      name: "Recorder",
      role: "guest",
      capabilities: { canEditWhiteboard: false, canControlSurface: false, canManageWhiteboard: false },
      sid: "meet-whiteboard_123",
      connectionId: "recorder",
      grantPrincipal: { type: "guest_admission", id: "recorder" },
      service: "recorder",
    });

    const response = await handleRecorderAuth(recorderAuthRequest({ recorderToken }), env());

    expect(response.status).toBe(401);
    expect(canAccessWhiteboardAsRecorderMock).not.toHaveBeenCalled();
  });

  it("denies exchange when recorder access is no longer active for the meeting", async () => {
    const { handleRecorderAuth } = await import("@/modules/whiteboards/server/http/recorder-auth");
    createDbMock.mockReturnValue({});
    canAccessWhiteboardAsRecorderMock.mockResolvedValue(false);
    const recorderToken = await createRecorderBootstrapToken({ AUTH_SECRET }, MEETING_ID);

    const response = await handleRecorderAuth(recorderAuthRequest({ recorderToken }), env());

    expect(response.status).toBe(403);
  });

  it("follows the board the meeting presents now, including one presented after the recording started", async () => {
    const { handleRecorderAuth } = await import("@/modules/whiteboards/server/http/recorder-auth");
    createDbMock.mockReturnValue({});
    canAccessWhiteboardAsRecorderMock.mockResolvedValue(true);
    const recorderToken = await createRecorderBootstrapToken({ AUTH_SECRET }, MEETING_ID);

    findMeetingWhiteboardDocumentMock.mockResolvedValue(null);
    expect((await handleRecorderAuth(recorderAuthRequest({ recorderToken }), env())).status).toBe(404);

    findMeetingWhiteboardDocumentMock.mockResolvedValue(presentedBoard("whiteboard_456"));
    const response = await handleRecorderAuth(recorderAuthRequest({ recorderToken }), env());
    expect(response.status).toBe(200);
    const payload = await response.json() as { token: string; documentId: string };
    expect(payload.documentId).toBe("whiteboard_456");
    expect(await verifyWhiteboardJWT(payload.token, TEST_JWT_KEYRING)).toMatchObject({ sid: "meet-whiteboard_456" });
  });
});

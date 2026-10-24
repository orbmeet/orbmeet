import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWhiteboardJWT } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import { TEST_JWT_KEYRING, TEST_WHITEBOARD_ENV } from "@/test/fake-sync-server";
import type { WhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";

const createDbMock = vi.fn();
const findCommittedAsset = vi.fn();
const verifySessionFromRawRequestMock = vi.fn();
const canAccessMeetingHistoryMock = vi.fn();
const canRecorderReadWhiteboardAssetMock = vi.fn();
const canActiveParticipantReadWhiteboardAssetMock = vi.fn();
const resolveMeetingIdForWhiteboardConnectionMock = vi.fn();
const resolveOpenMeetingPresentingWhiteboardMock = vi.fn();
const isMeetingAttachedToWhiteboardRoomMock = vi.fn();
const isWhiteboardRoomIdentityMock = vi.fn();
const canUserReadWhiteboardDocumentMock = vi.fn();
const verifyGuestAdmissionBySecretMock = vi.fn();

vi.mock("@orbmeet/db", () => ({
  createDb: () => {
    const db = createDbMock();
    return { ...db, query: { ...db?.query, whiteboardAssets: { findFirst: findCommittedAsset } } };
  },
}));

vi.mock("@/modules/identity/server/session", () => ({
  verifySessionFromRawRequest: verifySessionFromRawRequestMock,
}));

vi.mock("@/platform/http/cookies.server", () => ({
  getCookieValue: (cookieHeader: string | null, name: string, options?: { path?: string }) => {
    if (!cookieHeader) return null;
    const stored = `${(options?.path ?? "/") === "/" ? "__Host-" : "__Secure-"}${name}`;
    for (const cookie of cookieHeader.split(";")) {
      const [rawName, ...rawValue] = cookie.trim().split("=");
      if (rawName === stored) return rawValue.join("=");
    }
    return null;
  },
  getGuestCookieSecretFromCookie: (cookieHeader: string | null, admissionId: string) => {
    if (!cookieHeader) return null;
    const name = `__Host-guest_${admissionId}`;
    for (const cookie of cookieHeader.split(";")) {
      const [rawName, ...rawValue] = cookie.trim().split("=");
      if (rawName === name) return rawValue.join("=");
    }
    return null;
  },
}));

vi.mock("@/modules/meetings/server/access/resource-access", () => ({
  canAccessMeetingHistory: canAccessMeetingHistoryMock,
}));

vi.mock("@/modules/whiteboards/server/meeting/asset-access", () => ({
  canRecorderReadWhiteboardAsset: canRecorderReadWhiteboardAssetMock,
  canActiveParticipantReadWhiteboardAsset: canActiveParticipantReadWhiteboardAssetMock,
}));

vi.mock("@/modules/whiteboards/server/documents", () => ({
  resolveMeetingIdForWhiteboardConnection: resolveMeetingIdForWhiteboardConnectionMock,
  resolveOpenMeetingPresentingWhiteboard: resolveOpenMeetingPresentingWhiteboardMock,
  isMeetingAttachedToWhiteboardRoom: isMeetingAttachedToWhiteboardRoomMock,
  isWhiteboardRoomIdentity: isWhiteboardRoomIdentityMock,
  canUserReadWhiteboardDocument: canUserReadWhiteboardDocumentMock,
}));

vi.mock("@/modules/meetings/server/access/guest-admission", () => ({
  verifyGuestAdmissionBySecret: verifyGuestAdmissionBySecretMock,
}));

// The route's pre-authorization budget. Its own behaviour is covered in
// rate-limit tests; here it must not stand in front of every other assertion.
const enforceWhiteboardAssetRateLimitMock = vi.fn(async () => {});
vi.mock("@/platform/http/rate-limit.server", () => ({
  enforceWhiteboardAssetRateLimit: enforceWhiteboardAssetRateLimitMock,
}));

/** A db whose usage lookup (`select … from … where`) answers `rows`. */
function capturingUsages(rows: Array<{ meetingId: string }>) {
  return { select: () => ({ from: () => ({ where: async () => rows }) }) };
}

const ROOM_ID = "meet-mtg_123" as WhiteboardRoomId;

describe("handleWbAssets", () => {
  beforeEach(() => { findCommittedAsset.mockResolvedValue({ id: "asset_1" }); });
  it("never serves an unregistered or rolled-back object through its owning board", async () => {
    const { handleWbAssets } = await import("./wb-assets");
    createDbMock.mockReturnValue({});
    findCommittedAsset.mockResolvedValue(undefined);
    const bucket = { get: vi.fn() };
    const key = "whiteboards/whiteboard_1/assets/asset_1.png";
    const response = await handleWbAssets(new Request(`https://example.com/api/wb-assets/${key}`),
      { DB: {}, R2_BUCKET: bucket } as unknown as Env, key);
    expect(response.status).toBe(404);
    expect(bucket.get).not.toHaveBeenCalled();
  });
  afterEach(() => {
    vi.resetAllMocks();
  });

  // `deleting` is the status that must not serve: a rolled-back upload or a
  // requested deletion, whose bytes are on their way out. `pending` is not a
  // trust state — no browser can PUT to a final key, since presigned uploads
  // all target `staging/` and the server promotes them here with a validated
  // copy — so it only means the object may not have arrived yet, which R2
  // answers on its own.
  //
  // Refusing it cost a real bug: a PDF import commits its rows at finalize,
  // which lands after the page shapes reach the canvas, so the page the
  // importing user is already looking at asked for its image inside that
  // window. A 404 there is permanent for the session, because an <img> that
  // fails never retries, and the first imported page stayed blank.
  it("serves a registered object whose row has not been committed yet", async () => {
    const { handleWbAssets } = await import("./wb-assets");
    createDbMock.mockReturnValue({});
    verifySessionFromRawRequestMock.mockResolvedValue(null);
    const bucket = { get: vi.fn() };

    const key =
      "whiteboards/whiteboard_1/assets/imports/c9269fa1-63a2-4960-8a13-f54c681892e0/page-1.png";
    await handleWbAssets(
      new Request(`https://example.com/api/wb-assets/${key}`),
      { DB: {}, R2_BUCKET: bucket } as unknown as Env,
      key,
    );

    expect(findCommittedAsset).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { r2Key: key, status: { in: ["pending", "committed"] } },
    }));
  });

  it("does not accept recorder tokens from asset URL query strings", async () => {
    const { handleWbAssets } = await import("@/modules/whiteboards/server/http/wb-assets");
    const bucket = { get: vi.fn() };
    createDbMock.mockReturnValue({});
    verifySessionFromRawRequestMock.mockResolvedValue(null);
    const token = await createWhiteboardJWT(TEST_JWT_KEYRING, {
      sub: "recorder",
      name: "Recorder",
      role: "guest",
      capabilities: { canEditWhiteboard: false, canControlSurface: false, canManageWhiteboard: false },
      sid: ROOM_ID,
      connectionId: "recorder",
      grantPrincipal: { type: "guest_admission", id: "recorder" },
      service: "recorder",
    });

    const response = await handleWbAssets(
      new Request(
        `https://app.example/api/wb-assets/whiteboard/mtg_123/assets/whiteboard_asset_1.png?wbToken=${encodeURIComponent(token)}`,
      ),
      {
        DB: {},
        R2_BUCKET: bucket,
        ...TEST_WHITEBOARD_ENV,
      } as unknown as Env,
      "whiteboards/mtg_123/assets/whiteboard_asset_1.png",
    );

    expect(response.status).toBe(401);
    expect(canRecorderReadWhiteboardAssetMock).not.toHaveBeenCalled();
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("serves an asset from the exact frozen revision to its admitted guest", async () => {
    const { handleWbAssets } = await import("@/modules/whiteboards/server/http/wb-assets");
    const key = "whiteboards/whiteboard_1/assets/whiteboard_asset_1.png";
    const limit = vi.fn().mockResolvedValue([{
      assetManifest: JSON.stringify([key]),
    }]);
    createDbMock.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ limit })),
          })),
        })),
      })),
    });
    verifySessionFromRawRequestMock.mockResolvedValue(null);
    verifyGuestAdmissionBySecretMock.mockResolvedValue({ id: "admission_1" });
    const bucket = {
      get: vi.fn().mockResolvedValue({
        body: "image",
        size: 5,
        httpEtag: '"etag"',
        httpMetadata: { contentType: "image/png" },
      }),
    };

    const params = new URLSearchParams({
      revisionId: "revision_1",
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      admissionId: "admission_1",
    });
    const response = await handleWbAssets(
      new Request(`https://app.example/api/wb-assets/${key}?${params}`, {
        headers: {
          Cookie: "__Host-guest_admission_1=private-occurrence-secret",
        },
      }),
      {
        DB: {},
        R2_BUCKET: bucket,
      } as unknown as Env,
      key,
    );

    expect(response.status).toBe(200);
    expect(verifyGuestAdmissionBySecretMock).toHaveBeenCalledWith(
      expect.anything(),
      "meeting_1",
      "admission_1",
      "private-occurrence-secret",
    );
    expect(bucket.get).toHaveBeenCalledWith(key);
  });

  it("serves an asset for the active Meeting Whiteboard", async () => {
    const { handleWbAssets } = await import("@/modules/whiteboards/server/http/wb-assets");
    createDbMock.mockReturnValue({ select: vi.fn() });
    resolveMeetingIdForWhiteboardConnectionMock.mockResolvedValue("meeting_current");
    isWhiteboardRoomIdentityMock.mockResolvedValue(true);
    canActiveParticipantReadWhiteboardAssetMock.mockResolvedValue(true);
    const token = await createWhiteboardJWT(TEST_JWT_KEYRING, {
      sub: "usr_1",
      name: "Alice",
      role: "participant",
      capabilities: { canEditWhiteboard: true, canControlSurface: false, canManageWhiteboard: false },
      sid: "meet-board_sync",
      connectionId: "conn_current",
      grantPrincipal: { type: "user", id: "usr_1" },
    });
    const key = "whiteboards/whiteboard_1/assets/whiteboard_asset_1.png";
    const bucket = {
      get: vi.fn().mockResolvedValue({
        body: "image",
        size: 5,
        httpEtag: '"etag"',
        httpMetadata: { contentType: "image/png" },
      }),
    };

    const response = await handleWbAssets(
      new Request(`https://app.example/api/wb-assets/${key}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      {
        DB: {},
        R2_BUCKET: bucket,
        ...TEST_WHITEBOARD_ENV,
      } as unknown as Env,
      key,
    );

    expect(response.status).toBe(200);
    expect(resolveMeetingIdForWhiteboardConnectionMock).toHaveBeenCalledWith(
      expect.anything(),
      "board_sync",
      "conn_current",
    );
    expect(isWhiteboardRoomIdentityMock).toHaveBeenCalledWith(
      expect.anything(),
      "whiteboard_1",
      "board_sync",
    );
    expect(canActiveParticipantReadWhiteboardAssetMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        meetingId: "meeting_current",
        connectionId: "conn_current",
        participantIdentity: "usr_1",
      },
    );
    expect(bucket.get).toHaveBeenCalledWith(key);
  });

  it("serves an active Whiteboard asset to its recorder service token", async () => {
    const { handleWbAssets } = await import("@/modules/whiteboards/server/http/wb-assets");
    createDbMock.mockReturnValue({ select: vi.fn() });
    resolveOpenMeetingPresentingWhiteboardMock.mockResolvedValue("meeting_current");
    isWhiteboardRoomIdentityMock.mockResolvedValue(true);
    canRecorderReadWhiteboardAssetMock.mockResolvedValue(true);
    const token = await createWhiteboardJWT(TEST_JWT_KEYRING, {
      sub: "recorder",
      name: "Recorder",
      role: "guest",
      capabilities: { canEditWhiteboard: false, canControlSurface: false, canManageWhiteboard: false },
      sid: "meet-board_sync",
      connectionId: "recorder",
      grantPrincipal: { type: "guest_admission", id: "recorder" },
      service: "recorder",
    });
    const key = "whiteboards/whiteboard_1/assets/whiteboard_asset_1.png";
    const bucket = {
      get: vi.fn().mockResolvedValue({
        body: "image",
        size: 5,
        httpEtag: '"etag"',
        httpMetadata: { contentType: "image/png" },
      }),
    };

    const response = await handleWbAssets(
      new Request(`https://app.example/api/wb-assets/${key}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { DB: {}, R2_BUCKET: bucket, ...TEST_WHITEBOARD_ENV } as unknown as Env,
      key,
    );

    expect(response.status).toBe(200);
    expect(resolveOpenMeetingPresentingWhiteboardMock).toHaveBeenCalledWith(
      expect.anything(),
      "board_sync",
    );
    expect(canRecorderReadWhiteboardAssetMock).toHaveBeenCalledWith(
      expect.anything(),
      "meeting_current",
    );
  });

  it("refuses the retired meeting-keyed asset layout before any authorization work", async () => {
    const { handleWbAssets } = await import("@/modules/whiteboards/server/http/wb-assets");
    createDbMock.mockReturnValue({});
    verifySessionFromRawRequestMock.mockResolvedValue({ userId: "usr_1" });
    canAccessMeetingHistoryMock.mockResolvedValue(true);
    const key = "uploads/usr_1/wb/meeting_history/file.png";
    const bucket = { get: vi.fn() };

    const response = await handleWbAssets(
      new Request(`https://app.example/api/wb-assets/${key}`),
      { DB: {}, R2_BUCKET: bucket } as unknown as Env,
      key,
    );

    expect(response.status).toBe(403);
    expect(verifySessionFromRawRequestMock).not.toHaveBeenCalled();
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("serves a document-owned asset using its scoped HttpOnly cookie", async () => {
    const { handleWbAssets } = await import("@/modules/whiteboards/server/http/wb-assets");
    createDbMock.mockReturnValue({});
    resolveMeetingIdForWhiteboardConnectionMock.mockResolvedValue("meeting_current");
    isWhiteboardRoomIdentityMock.mockResolvedValue(true);
    canActiveParticipantReadWhiteboardAssetMock.mockResolvedValue(true);
    const token = await createWhiteboardJWT(TEST_JWT_KEYRING, {
      sub: "usr_1",
      name: "Alice",
      role: "participant",
      capabilities: { canEditWhiteboard: true, canControlSurface: false, canManageWhiteboard: false },
      sid: "meet-board_sync",
      connectionId: "conn_current",
      grantPrincipal: { type: "user", id: "usr_1" },
    });
    const key = "whiteboards/whiteboard_1/assets/whiteboard_asset_1.png";
    const bucket = {
      get: vi.fn().mockResolvedValue({
        body: "image",
        size: 5,
        httpMetadata: { contentType: "image/png" },
      }),
    };

    const response = await handleWbAssets(
      new Request(
        `https://app.example/api/wb-assets/${key}?whiteboardId=whiteboard_1`,
        { headers: { Cookie: `__Secure-wb_asset_whiteboard_1=${token}` } },
      ),
      {
        DB: {},
        R2_BUCKET: bucket,
        ...TEST_WHITEBOARD_ENV,
      } as unknown as Env,
      key,
    );

    expect(response.status).toBe(200);
    expect(isWhiteboardRoomIdentityMock).toHaveBeenCalledWith(
      expect.anything(),
      "whiteboard_1",
      "board_sync",
    );
    expect(bucket.get).toHaveBeenCalledWith(key);
  });

  it("serves a historical document asset only when the selected revision manifests it", async () => {
    const { handleWbAssets } = await import("@/modules/whiteboards/server/http/wb-assets");
    const key = "whiteboards/whiteboard_1/assets/whiteboard_asset_historical.png";
    createDbMock.mockReturnValue({
      ...capturingUsages([{ meetingId: "meeting_history" }]),
      query: {
        whiteboardRevisions: {
          findFirst: vi.fn().mockResolvedValue({
            assetManifest: JSON.stringify([key]),
            sourceMeetingId: "meeting_history",
          }),
        },
      },
    });
    verifySessionFromRawRequestMock.mockResolvedValue({ userId: "usr_1" });
    canAccessMeetingHistoryMock.mockResolvedValue(true);
    const bucket = {
      get: vi.fn().mockResolvedValue({
        body: "image",
        size: 5,
        httpMetadata: { contentType: "image/png" },
      }),
    };

    const response = await handleWbAssets(
      new Request(
        `https://app.example/api/wb-assets/${key}?revisionId=revision_1`,
      ),
      { DB: {}, R2_BUCKET: bucket } as unknown as Env,
      key,
    );

    expect(response.status).toBe(200);
    expect(canAccessMeetingHistoryMock).toHaveBeenCalledWith(
      expect.anything(),
      "meeting_history",
      "usr_1",
    );
    expect(bucket.get).toHaveBeenCalledWith(key);
  });

  it("serves a reused revision's assets to a viewer of the Meeting that reused it (WB-06)", async () => {
    const { handleWbAssets } = await import("@/modules/whiteboards/server/http/wb-assets");
    const key = "whiteboards/whiteboard_1/assets/whiteboard_asset_reused.png";
    createDbMock.mockReturnValue({
      // Meeting A made the revision; Meeting B's unchanged board reused it.
      ...capturingUsages([{ meetingId: "meeting_a" }, { meetingId: "meeting_b" }]),
      query: {
        whiteboardRevisions: {
          findFirst: vi.fn().mockResolvedValue({
            assetManifest: JSON.stringify([key]),
            sourceMeetingId: "meeting_a",
          }),
        },
      },
    });
    verifySessionFromRawRequestMock.mockResolvedValue({ userId: "usr_b" });
    canAccessMeetingHistoryMock.mockImplementation(async (_db, meetingId: string) => meetingId === "meeting_b");
    const bucket = {
      get: vi.fn().mockResolvedValue({ body: "image", size: 5, httpMetadata: { contentType: "image/png" } }),
    };

    const response = await handleWbAssets(
      new Request(`https://app.example/api/wb-assets/${key}?revisionId=revision_1`),
      { DB: {}, R2_BUCKET: bucket } as unknown as Env,
      key,
    );

    expect(response.status).toBe(200);
  });

  it("refuses a revision's assets to a viewer of no Meeting that shows it", async () => {
    const { handleWbAssets } = await import("@/modules/whiteboards/server/http/wb-assets");
    const key = "whiteboards/whiteboard_1/assets/whiteboard_asset_reused.png";
    createDbMock.mockReturnValue({
      ...capturingUsages([{ meetingId: "meeting_a" }]),
      query: {
        whiteboardRevisions: {
          findFirst: vi.fn().mockResolvedValue({
            assetManifest: JSON.stringify([key]),
            sourceMeetingId: "meeting_a",
          }),
        },
      },
    });
    verifySessionFromRawRequestMock.mockResolvedValue({ userId: "usr_c" });
    canAccessMeetingHistoryMock.mockResolvedValue(false);
    const bucket = { get: vi.fn() };

    const response = await handleWbAssets(
      new Request(`https://app.example/api/wb-assets/${key}?revisionId=revision_1`),
      { DB: {}, R2_BUCKET: bucket } as unknown as Env,
      key,
    );

    expect(response.status).toBe(403);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("refuses a historical asset absent from the immutable revision manifest", async () => {
    const { handleWbAssets } = await import("@/modules/whiteboards/server/http/wb-assets");
    const key = "whiteboards/whiteboard_1/assets/whiteboard_asset_unrelated.png";
    createDbMock.mockReturnValue({
      query: {
        whiteboardRevisions: {
          findFirst: vi.fn().mockResolvedValue({ assetManifest: "[]" }),
        },
      },
    });
    verifySessionFromRawRequestMock.mockResolvedValue({ userId: "usr_1" });
    const bucket = { get: vi.fn() };

    const response = await handleWbAssets(
      new Request(
        `https://app.example/api/wb-assets/${key}?revisionId=revision_1`,
      ),
      { DB: {}, R2_BUCKET: bucket } as unknown as Env,
      key,
    );

    expect(response.status).toBe(403);
    expect(canAccessMeetingHistoryMock).not.toHaveBeenCalled();
    expect(bucket.get).not.toHaveBeenCalled();
  });

  async function participantRequest(headers: Record<string, string>) {
    const { handleWbAssets } = await import("@/modules/whiteboards/server/http/wb-assets");
    createDbMock.mockReturnValue({});
    verifySessionFromRawRequestMock.mockResolvedValue(null);
    canActiveParticipantReadWhiteboardAssetMock.mockResolvedValue(true);
    resolveMeetingIdForWhiteboardConnectionMock.mockResolvedValue("mtg_123");
    isWhiteboardRoomIdentityMock.mockResolvedValue(true);
    const token = await createWhiteboardJWT(TEST_JWT_KEYRING, {
      sub: "usr_1",
      name: "Alice",
      role: "participant",
      capabilities: { canEditWhiteboard: true, canControlSurface: false, canManageWhiteboard: false },
      sid: ROOM_ID,
      connectionId: "conn_1",
      grantPrincipal: { type: "user", id: "usr_1" },
    });
    const key = "whiteboards/mtg_123/assets/whiteboard_asset_1.mp4";
    return (bucket: { get: ReturnType<typeof vi.fn> }) =>
      handleWbAssets(
        new Request(`https://app.example/api/wb-assets/${key}`, {
          headers: { Authorization: `Bearer ${token}`, ...headers },
        }),
        {
          DB: {},
          R2_BUCKET: bucket,
          ...TEST_WHITEBOARD_ENV,
        } as unknown as Env,
        key,
      );
  }

  // The cache's whole purpose is to keep board opens off this path, so the
  // revalidation it falls back to must not cost what a miss costs. Reading the
  // object unconditionally and comparing ETags afterwards paid for the entire
  // body on every 304.
  it("revalidates through a conditional read instead of fetching the body", async () => {
    const send = await participantRequest({ "If-None-Match": '"etag"' });
    const bucket = {
      // R2 answers a failed `onlyIf` with metadata and no body.
      get: vi.fn().mockResolvedValue({
        size: 1000,
        httpEtag: '"etag"',
        httpMetadata: { contentType: "image/png" },
      }),
    };

    const response = await send(bucket);

    // R2 throws on the quoted HTTP form ("Conditional ETag should not be
    // wrapped in quotes"), so the header's quotes must be stripped.
    expect(bucket.get).toHaveBeenCalledWith(
      "whiteboards/mtg_123/assets/whiteboard_asset_1.mp4",
      { onlyIf: { etagDoesNotMatch: "etag" } },
    );
    expect(response.status).toBe(304);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, max-age=3600, must-revalidate",
    );
    expect(response.headers.get("Vary")).toBe("Cookie, Authorization");
  });

  it("serves the body when a conditional read finds the object changed", async () => {
    const send = await participantRequest({ "If-None-Match": '"stale"' });
    const bucket = {
      get: vi.fn().mockResolvedValue({
        body: "fresh-bytes",
        size: 11,
        httpEtag: '"etag"',
        httpMetadata: { contentType: "image/png" },
      }),
    };

    const response = await send(bucket);

    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"etag"');
  });

  it("matches weak and comma-separated If-None-Match validators", async () => {
    const send = await participantRequest({
      "If-None-Match": '"stale", W/"etag", "another"',
    });
    const bucket = {
      head: vi.fn().mockResolvedValue({
        size: 1000,
        httpEtag: '"etag"',
        httpMetadata: { contentType: "image/png" },
      }),
      get: vi.fn(),
    };

    const response = await send(bucket);

    expect(response.status).toBe(304);
    expect(bucket.head).toHaveBeenCalledOnce();
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("fetches the body when no weak or comma-separated validator matches", async () => {
    const send = await participantRequest({
      "If-None-Match": '"stale", W/"also-stale"',
    });
    const bucket = {
      head: vi.fn().mockResolvedValue({
        size: 11,
        httpEtag: '"etag"',
        httpMetadata: { contentType: "image/png" },
      }),
      get: vi.fn().mockResolvedValue({
        body: "fresh-bytes",
        size: 11,
        httpEtag: '"etag"',
        httpMetadata: { contentType: "image/png" },
      }),
    };

    const response = await send(bucket);

    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe('"etag"');
    expect(bucket.head).toHaveBeenCalledOnce();
    expect(bucket.get).toHaveBeenCalledWith("whiteboards/mtg_123/assets/whiteboard_asset_1.mp4");
  });

  it("treats If-None-Match wildcard as matching an existing object", async () => {
    const send = await participantRequest({ "If-None-Match": "*" });
    const bucket = {
      head: vi.fn().mockResolvedValue({
        size: 1000,
        httpEtag: '"etag"',
        httpMetadata: { contentType: "image/png" },
      }),
      get: vi.fn(),
    };

    const response = await send(bucket);

    expect(response.status).toBe(304);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("serves a single byte range as a 206 with Content-Range", async () => {
    const send = await participantRequest({ Range: "bytes=0-99" });
    const bucket = {
      get: vi.fn().mockResolvedValue({
        body: "range-bytes",
        size: 1000,
        httpEtag: '"etag"',
        httpMetadata: { contentType: "video/mp4" },
      }),
    };

    const response = await send(bucket);

    expect(bucket.get).toHaveBeenCalledWith(
      "whiteboards/mtg_123/assets/whiteboard_asset_1.mp4",
      { range: { offset: 0, length: 100 } },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 0-99/1000");
    expect(response.headers.get("Content-Length")).toBe("100");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    // Same lifetime as a full response, pinned to the whiteboard JWT's own
    // hour: the bytes at a key never change, but who may read them does, so a
    // cached copy never outlives the credential it was served under.
    expect(response.headers.get("Cache-Control")).toBe(
      "private, max-age=3600, must-revalidate",
    );
    expect(verifySessionFromRawRequestMock).not.toHaveBeenCalled();
  });

  it("clamps open-ended ranges to the object size", async () => {
    const send = await participantRequest({ Range: "bytes=900-" });
    const bucket = {
      get: vi.fn().mockResolvedValue({
        body: "tail",
        size: 1000,
        httpEtag: '"etag"',
        httpMetadata: { contentType: "video/mp4" },
      }),
    };

    const response = await send(bucket);

    expect(bucket.get).toHaveBeenCalledWith(
      "whiteboards/mtg_123/assets/whiteboard_asset_1.mp4",
      { range: { offset: 900 } },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 900-999/1000");
    expect(response.headers.get("Content-Length")).toBe("100");
  });

  it("ignores malformed or multi-range headers and serves the full object", async () => {
    const send = await participantRequest({ Range: "bytes=0-49,100-149" });
    const bucket = {
      get: vi.fn().mockResolvedValue({
        body: "everything",
        size: 1000,
        httpEtag: '"etag"',
        httpMetadata: { contentType: "video/mp4" },
      }),
    };

    const response = await send(bucket);

    expect(bucket.get).toHaveBeenCalledWith("whiteboards/mtg_123/assets/whiteboard_asset_1.mp4");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(response.headers.get("Content-Length")).toBe("1000");
  });

  it("returns 416 with the object size when R2 rejects the range", async () => {
    const send = await participantRequest({ Range: "bytes=5000-" });
    const bucket = {
      get: vi.fn().mockRejectedValue(
        new Error("get: The requested range is not satisfiable (10039)"),
      ),
      head: vi.fn().mockResolvedValue({ size: 1000 }),
    };

    const response = await send(bucket);

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */1000");
  });

  it("propagates non-range R2 failures on ranged requests instead of masking them as 416", async () => {
    const send = await participantRequest({ Range: "bytes=0-99" });
    const bucket = {
      get: vi.fn().mockRejectedValue(new Error("get: internal error (10001)")),
      head: vi.fn(),
    };

    await expect(send(bucket)).rejects.toThrow("internal error");
    expect(bucket.head).not.toHaveBeenCalled();
  });
});

describe("handleWbAssets rate limiting", () => {
  it("refuses before doing any authorization work", async () => {
    const { Errors } = await import("@/lib/app-errors");
    enforceWhiteboardAssetRateLimitMock.mockRejectedValueOnce(Errors.RATE_LIMITED());
    createDbMock.mockReturnValue({});

    const { handleWbAssets } = await import("@/modules/whiteboards/server/http/wb-assets");
    await expect(
      handleWbAssets(
        new Request("https://app.test/api/wb-assets/whiteboards/whiteboard_1/assets/a.png"),
        { R2_BUCKET: {} } as unknown as Env,
        "whiteboards/whiteboard_1/assets/a.png",
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });

    expect(findCommittedAsset).not.toHaveBeenCalled();
    expect(verifySessionFromRawRequestMock).not.toHaveBeenCalled();
  });
});

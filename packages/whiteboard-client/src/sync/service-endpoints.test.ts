import { describe, expect, it } from "vitest";
import {
  WHITEBOARD_SYNC_ROUTES,
  whiteboardPdfImportRoute,
} from "@orbmeet/whiteboard-core/protocol";
import {
  buildWhiteboardConnectUrl,
  defineWhiteboardServiceEndpoints,
  whiteboardSyncUrl,
} from "./service-endpoints";

const VALID_ENDPOINTS = {
  recorderAuth: "/api/whiteboard/recorder-auth",
};

describe("defineWhiteboardServiceEndpoints", () => {
  it("returns a frozen adapter carrying exactly the supplied endpoints", () => {
    const endpoints = defineWhiteboardServiceEndpoints(VALID_ENDPOINTS);
    expect(endpoints).toEqual(VALID_ENDPOINTS);
    expect(Object.isFrozen(endpoints)).toBe(true);
  });

  it("rejects a missing adapter with a clear error", () => {
    expect(() =>
      defineWhiteboardServiceEndpoints(null as unknown as typeof VALID_ENDPOINTS),
    ).toThrow(/not configured/);
    expect(() =>
      defineWhiteboardServiceEndpoints(undefined as unknown as typeof VALID_ENDPOINTS),
    ).toThrow(/not configured/);
  });

  it("names every missing or empty endpoint in the error", () => {
    expect(() =>
      defineWhiteboardServiceEndpoints({ recorderAuth: "   " }),
    ).toThrow(/missing: recorderAuth/);

    expect(() => defineWhiteboardServiceEndpoints({} as typeof VALID_ENDPOINTS)).toThrow(
      /missing: recorderAuth/,
    );
  });

  it("rejects non-string endpoint values", () => {
    expect(() =>
      defineWhiteboardServiceEndpoints({
        recorderAuth: 42 as unknown as string,
      }),
    ).toThrow(/recorderAuth/);
  });
});

describe("sync protocol contract", () => {
  // These pins are the drift alarm for the whiteboard-server wire protocol: if
  // the shared contract changes a path, this test fails and forces the change
  // to be reconciled with the sync server and every deployed client.
  it("exposes exactly the wire paths the sync server serves", () => {
    expect(WHITEBOARD_SYNC_ROUTES).toEqual({
      connect: "/connect",
      assistant: "/assistant",
      unfurl: "/unfurl",
      pdfImport: "/pdf-import",
    });
  });

  it("builds a PDF import's route from the shared root", () => {
    expect(whiteboardPdfImportRoute("job-1")).toBe("/pdf-import/job-1");
  });
});

describe("whiteboardSyncUrl", () => {
  it("resolves contract routes against the sync server origin", () => {
    expect(whiteboardSyncUrl("https://sync.example.com", WHITEBOARD_SYNC_ROUTES.assistant)).toBe(
      "https://sync.example.com/assistant",
    );
    expect(whiteboardSyncUrl("https://sync.example.com/", WHITEBOARD_SYNC_ROUTES.unfurl)).toBe(
      "https://sync.example.com/unfurl",
    );
  });

  it("treats route paths as root-relative", () => {
    expect(
      whiteboardSyncUrl("https://sync.example.com/rooms", WHITEBOARD_SYNC_ROUTES.pdfImport),
    ).toBe("https://sync.example.com/pdf-import");
  });
});

describe("buildWhiteboardConnectUrl", () => {
  it("upgrades to wss for https sync servers and carries the token fragment", () => {
    expect(buildWhiteboardConnectUrl("https://sync.example.com", "tok")).toBe(
      "wss://sync.example.com/connect#token=tok",
    );
  });

  it("keeps ws for plaintext sync servers", () => {
    expect(buildWhiteboardConnectUrl("http://localhost:8787", "tok")).toBe(
      "ws://localhost:8787/connect#token=tok",
    );
  });
});

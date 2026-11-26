import { describe, expect, it } from "vitest";
import {
  buildWhiteboardConnectUrl,
  reconcileEditAccessRequestPending,
  WHITEBOARD_SYNC_ROUTES,
  whiteboardPdfImportRoute,
  whiteboardSyncUrl,
} from "./protocol.ts";

describe("sync protocol contract", () => {
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

  it("percent-encodes special characters in the token fragment", () => {
    expect(buildWhiteboardConnectUrl("https://sync.example.com/base", "a+b=c&d")).toBe(
      "wss://sync.example.com/connect#token=a%2Bb%3Dc%26d",
    );
  });
});

describe("reconcileEditAccessRequestPending", () => {
  it("restores a pending request from authoritative room state", () => {
    expect(reconcileEditAccessRequestPending(false, true)).toBe(true);
  });

  it("clears stale local waiting state after denial or server restart", () => {
    expect(reconcileEditAccessRequestPending(false, false)).toBe(false);
    expect(reconcileEditAccessRequestPending(false, undefined)).toBe(false);
  });

  it("never shows a pending request once edit access is granted", () => {
    expect(reconcileEditAccessRequestPending(true, true)).toBe(false);
  });
});

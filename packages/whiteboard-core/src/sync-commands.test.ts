import { describe, expect, it } from "vitest";
import {
  parseSyncCommandPath,
  parseSyncCommandRequest,
  parseSyncCommandResult,
  parseSyncHealth,
  readPageTarget,
  speaksWith,
  SYNC_PROTOCOL,
  syncCommandPath,
  syncProtocolOf,
  type SyncCommandName,
  type SyncCommandRequest,
} from "./sync-commands.ts";

describe("parseSyncCommandPath", () => {
  it("round-trips a command's path", () => {
    expect(parseSyncCommandPath(syncCommandPath("capture"))).toBe("capture");
    expect(parseSyncCommandPath(syncCommandPath("navigationControllerRelease"))).toBe(
      "navigationControllerRelease",
    );
  });

  it("refuses unknown names, inherited keys and other prefixes", () => {
    expect(parseSyncCommandPath("/commands/checkpoint")).toBeNull();
    expect(parseSyncCommandPath("/commands/toString")).toBeNull();
    expect(parseSyncCommandPath("/commands/__proto__")).toBeNull();
    expect(parseSyncCommandPath("/capture")).toBeNull();
  });
});

describe("parseSyncCommandResult", () => {
  it("accepts a success and a failure with a known reason", () => {
    expect(parseSyncCommandResult({ ok: true, status: "purged" })).toEqual({ ok: true, status: "purged" });
    const failure = { ok: false, reason: "busy", message: "Busy" };
    expect(parseSyncCommandResult(failure)).toEqual(failure);
  });

  it("refuses anything that is not a typed result", () => {
    expect(parseSyncCommandResult(null)).toBeNull();
    expect(parseSyncCommandResult("ok")).toBeNull();
    expect(parseSyncCommandResult({ ok: "true" })).toBeNull();
    expect(parseSyncCommandResult({ ok: false, reason: "teapot", message: "x" })).toBeNull();
    expect(parseSyncCommandResult({ ok: false, reason: "toString", message: "x" })).toBeNull();
    expect(parseSyncCommandResult({ ok: false, reason: "busy" })).toBeNull();
  });
});

describe("parseSyncCommandRequest", () => {
  // One request per command, written as a sender writes it: the contract's
  // own type. Each must read back as itself, so the schema accepts what the
  // type allows.
  const room = { whiteboardRoomId: "meet-room_1" as const, generation: 3 };
  const document = { ...room, whiteboardId: "wb_1", commandId: "cmd_0123456789", startBefore: 1_000 };
  const requests: { [C in SyncCommandName]: SyncCommandRequest<C> } = {
    open: document,
    capture: { ...document, toKey: "whiteboards/wb_1/revisions/r.json" },
    archive: document,
    reopen: document,
    restore: { ...document, sourceKey: "a.json", restorePointKey: "b.json" },
    seed: { ...document, source: { whiteboardRoomId: "meet-room_2", whiteboardId: "wb_2" } },
    handoff: { ...room, whiteboardId: "wb_1", ifIdle: true },
    purge: { ...room, whiteboardId: "wb_1" },
    refreshAuthority: { ...room, principalKey: "user:user_1" },
    copySnapshot: { sourceKey: "a.json", destinationKey: "b.json" },
    readSnapshot: { key: "a.json" },
    editRequest: { ...room, principalKey: "user:user_1", userId: "user_1", userName: "Ada" },
    editResolve: { ...room, targetPrincipalKey: "user:user_1", approverId: "user_2", outcome: "approved" },
    pageEditValidate: { ...room, userId: "user_1", connectionId: "c1", pageId: "shape:page_1" },
    pagePresentValidate: { ...room, userId: "user_1", connectionId: "c1", pageId: "shape:page_1" },
    pageAdd: { ...room, userId: "user_1", connectionId: "c1", afterPageNumber: 2 },
    navigationControllerSet: { ...room, targetUserId: "user_1", approverId: "user_2" },
    navigationControllerRelease: { ...room, requesterId: "user_1" },
  };

  it.each(Object.keys(requests) as SyncCommandName[])("reads a %s request as the sender wrote it", (name) => {
    expect(parseSyncCommandRequest(name, JSON.parse(JSON.stringify(requests[name])))).toEqual(requests[name]);
  });

  it("refuses a request the contract does not allow, saying what is wrong", () => {
    expect(parseSyncCommandRequest("open", { ...document, whiteboardRoomId: "room_1" }))
      .toMatchObject({ ok: false, reason: "invalid", message: expect.stringContaining("whiteboardRoomId") });
    expect(parseSyncCommandRequest("capture", { ...document, toKey: "" }))
      .toMatchObject({ ok: false, reason: "invalid" });
    expect(parseSyncCommandRequest("handoff", { ...room, whiteboardId: "../wb" }))
      .toMatchObject({ ok: false, reason: "invalid" });
    expect(parseSyncCommandRequest("open", { ...document, generation: -1 }))
      .toMatchObject({ ok: false, reason: "invalid" });
  });

  it("refuses a presented page that is not a page frame's id", () => {
    expect(parseSyncCommandRequest("pagePresentValidate", { ...room, userId: "user_1", connectionId: "c1", pageId: "page:page" }))
      .toMatchObject({ ok: false, reason: "invalid" });
  });

  it("cuts a requester's name to fit and drops control characters", () => {
    const parsed = parseSyncCommandRequest("editRequest", {
      ...room, principalKey: "user:user_1", userId: "user_1", userName: `A\u0007${"é".repeat(200)}`,
    });
    expect(parsed).toMatchObject({ userName: `A${"é".repeat(127)}` });
  });
});

describe("sync protocol", () => {
  it("reads a request without the header as the version before it existed", () => {
    expect(syncProtocolOf(null)).toBe(1);
    expect(syncProtocolOf("2")).toBe(2);
    expect(syncProtocolOf("two")).toBeNull();
  });

  it("speaks with a side only when each speaks what the other accepts", () => {
    const v1 = { speaks: 1, accepts: { oldest: 1, newest: 1 } };
    const accepting2 = { speaks: 1, accepts: { oldest: 1, newest: 2 } };
    const speaking2 = { speaks: 2, accepts: { oldest: 1, newest: 2 } };
    const only2 = { speaks: 2, accepts: { oldest: 2, newest: 2 } };
    // Each step of a change, against the step before and after it.
    expect(speaksWith(v1, accepting2)).toBe(true);
    expect(speaksWith(accepting2, speaking2)).toBe(true);
    expect(speaksWith(speaking2, only2)).toBe(true);
    // Skipping a step does not work.
    expect(speaksWith(v1, speaking2)).toBe(false);
    expect(speaksWith(accepting2, only2)).toBe(false);
  });

  it("reads a health answer from before protocols as speaking only the first", () => {
    expect(parseSyncHealth({ ok: true })).toEqual({ ok: true, protocol: { speaks: 1, accepts: { oldest: 1, newest: 1 } } });
    expect(parseSyncHealth({ ok: true, protocol: SYNC_PROTOCOL })).toEqual({ ok: true, protocol: SYNC_PROTOCOL });
    expect(parseSyncHealth({ ok: true, protocol: { speaks: 3, accepts: { oldest: 1, newest: 2 } } })).toBeNull();
    expect(parseSyncHealth({ ok: false })).toBeNull();
  });
});

describe("readPageTarget", () => {
  it("reads the page a page add answered with", () => {
    expect(readPageTarget({ pageId: "shape:page_2", pageNumber: 2 })).toEqual({ pageId: "shape:page_2", pageNumber: 2 });
  });

  it("reads nothing from an answer without a usable page", () => {
    expect(readPageTarget(undefined)).toBeNull();
    expect(readPageTarget({ pageId: "page:page", pageNumber: 1 })).toBeNull();
    expect(readPageTarget({ pageId: "shape:page_2", pageNumber: 0 })).toBeNull();
    expect(readPageTarget({ pageId: "shape:page_2", pageNumber: 1.5 })).toBeNull();
  });
});

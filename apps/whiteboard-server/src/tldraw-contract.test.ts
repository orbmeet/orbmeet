import * as syncCore from "@tldraw/sync-core";
import { InMemorySyncStorage, TLSocketRoom } from "@tldraw/sync-core";
import type { TLRecord } from "@tldraw/tlschema";
import { describe, expect, it } from "vitest";
import { whiteboardTLSchema } from "@orbmeet/whiteboard-core/room-schema";

/**
 * What the room relies on tldraw's sync to do, held here so that a tldraw
 * upgrade which changes any of it fails a test instead of quietly changing
 * the room's behaviour. Each case names the room code that depends on it.
 */

const { getTlsyncProtocolVersion } = syncCore as unknown as { getTlsyncProtocolVersion(): number };

type Sent = { type: string; [key: string]: unknown };

function connectedRoom(options: {
  isReadonly?: boolean;
  authorizeShape?: (next: TLRecord) => boolean;
} = {}) {
  const room = new TLSocketRoom<TLRecord, void>({
    schema: whiteboardTLSchema,
    storage: new InMemorySyncStorage<TLRecord>(),
    ...(options.authorizeShape
      ? {
          authorizeRecord: {
            shape: ({ next, prev }: { next: TLRecord | null; prev: TLRecord | null }) =>
              next && !options.authorizeShape!(next) ? null : (next ?? prev),
          },
        }
      : {}),
  } as ConstructorParameters<typeof TLSocketRoom<TLRecord, void>>[0]);
  const sent: Sent[] = [];
  const socket = {
    readyState: 1,
    send: (data: string) => {
      const message = JSON.parse(data) as Sent;
      if (message.type === "data") sent.push(...(message.data as Sent[]));
      else sent.push(message);
    },
    close: () => {},
  };
  room.handleSocketConnect({ sessionId: "s", socket, isReadonly: options.isReadonly ?? false });
  room.handleSocketMessage("s", JSON.stringify({
    type: "connect",
    protocolVersion: getTlsyncProtocolVersion(),
    schema: whiteboardTLSchema.serialize(),
    connectRequestId: "c",
    lastServerClock: -1,
  }));
  let clock = 0;
  const push = (message: Record<string, unknown>) => {
    clock += 1;
    room.handleSocketMessage("s", JSON.stringify({ type: "push", clientClock: clock, ...message }));
    return sent.filter((event) => event.type === "push_result" && event.clientClock === clock).at(-1);
  };
  return { room, push, sent };
}

function geo(id: string) {
  return {
    id, typeName: "shape", type: "geo", x: 0, y: 0, rotation: 0, index: "a1", parentId: "page:page",
    isLocked: false, opacity: 1, meta: {},
    props: {
      geo: "rectangle", dash: "draw", url: "", w: 100, h: 100, growY: 0, scale: 1, flipX: false, flipY: false,
      labelColor: "black", color: "black", fill: "none", size: "m", font: "draw", align: "middle",
      verticalAlign: "middle", richText: { type: "doc", content: [{ type: "paragraph" }] },
    },
  };
}

describe("tldraw sync, as the room relies on it", () => {
  // RoomMessageGuard hands a viewer's push on whole: tldraw must skip its
  // document ops, answer `discard` so the viewer rolls them back, and keep the
  // session.
  it("skips a readonly session's document ops and answers its push with discard", () => {
    const { room, push } = connectedRoom({ isReadonly: true });

    const result = push({ diff: { "shape:a": ["put", geo("shape:a")] } });

    expect(result).toMatchObject({ action: "discard" });
    expect(room.getRecord("shape:a")).toBeUndefined();
    expect(room.getNumActiveSessions()).toBe(1);
  });

  // The room's authorizers refuse record by record (room-record-authorizers):
  // a refused record must be skipped alone, the rest of the push landing.
  it("skips only the records an authorizer refuses", () => {
    const { room, push } = connectedRoom({ authorizeShape: (next) => next.id !== "shape:refused" });

    push({ diff: { "shape:kept": ["put", geo("shape:kept")], "shape:refused": ["put", geo("shape:refused")] } });

    expect(room.getRecord("shape:kept")).toBeDefined();
    expect(room.getRecord("shape:refused")).toBeUndefined();
  });

  // RoomMessageGuard answers a refused push by handing tldraw an empty diff
  // under the client's clock (`discardPush`): the reply must be `discard`.
  it("answers an empty diff under a pending clock with discard", () => {
    const { push } = connectedRoom();

    expect(push({ diff: {} })).toMatchObject({ action: "discard" });
  });

  // RoomPresenceLane applies patches with sync-core's own function and the
  // retained-presence guard reads its presence store, both @internal.
  it("still provides the internals the room uses", () => {
    expect(typeof (syncCore as { applyObjectDiff?: unknown }).applyObjectDiff).toBe("function");
    expect(typeof (TLSocketRoom.prototype as { getPresenceRecords?: unknown }).getPresenceRecords).toBe("function");
  });

  // Why RoomMessageGuard refuses any message carrying a prototype-polluting
  // key before tldraw sees it: the released sync-core applies a patch's
  // `__proto__` as the prototype, and its validator accepts the key inside a
  // record's free-form JSON. Should tldraw start dropping it, the first half
  // fails here, and the guard's scan can be reconsidered.
  it("applies __proto__ from a patch, and accepts it inside free-form JSON", () => {
    const applyObjectDiff = (syncCore as unknown as {
      applyObjectDiff(object: object, diff: Record<string, unknown>): Record<string, unknown>;
    }).applyObjectDiff;
    const patched = applyObjectDiff({ a: 1 }, JSON.parse('{"__proto__":["put",{"polluted":true}]}'));
    expect(Object.getPrototypeOf(patched)).toEqual({ polluted: true });

    const shapeType = whiteboardTLSchema.types.shape as unknown as { validate(record: unknown): unknown };
    expect(() => shapeType.validate({ ...geo("shape:a"), meta: JSON.parse('{"__proto__":{"polluted":true}}') }))
      .not.toThrow();
  });
});

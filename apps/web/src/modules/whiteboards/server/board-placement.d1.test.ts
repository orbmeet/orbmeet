import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { meetingLinks, meetings, meetingWhiteboards, nodeHealth, users, whiteboards } from "@orbmeet/db/schema";
import { parseSyncCommandPath } from "@orbmeet/whiteboard-core/sync-commands";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import { placeBoard } from "./board-placement.server";

const NOW = new Date("2026-10-11T00:00:00.000Z");
// Each node's latency as measured from the data centre an editor came in through.
const FROM_SINGAPORE = { sg1: 2, ams1: 160 };
const FROM_LONDON = { sg1: 170, ams1: 8 };

/** A node running media and the whiteboard, with keys of its own. */
function node(id: string, weight = 1) {
  const key = (kind: string) => ({ [`${id}-${kind}`]: `${id}-${kind}-${"k".repeat(40)}` });
  return {
    weight,
    media: { url: `wss://${id}.rtc.example`, capacity: 100, keys: key("lk") },
    whiteboard: { url: `https://${id}.whiteboard.example`, jwt: key("jwt"), command: key("cmd"), callback: key("cb") },
  };
}

const env = (nodes: Record<string, object> = {}) => ({
  DB: workerEnv.DB,
  NODES: JSON.stringify({ sg1: node("sg1"), ams1: node("ams1"), ...nodes }),
}) as unknown as Env;

async function recordFailures(nodeId: string, service: "media" | "whiteboard", failures: number) {
  await db.insert(nodeHealth).values({ nodeId, service, checkedAt: NOW, failures });
}

/** Every node's sync server: records each command it gets, answers a handoff as `handoff` says. */
let received: Array<{ node: string; name: string; body: Record<string, unknown> }> = [];
let handoff: () => Response = () => Response.json({ ok: true, savedGeneration: 1 });

let db: TestDb;

beforeEach(async () => {
  received = [];
  handoff = () => Response.json({ ok: true, savedGeneration: 1 });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const name = parseSyncCommandPath(url.pathname) ?? url.pathname;
    received.push({ node: url.hostname.split(".")[0], name, body: JSON.parse(String(init?.body ?? "{}")) });
    return name === "handoff" ? handoff() : Response.json({ ok: false, reason: "not_found", message: "no handler" });
  }));
  db = await createTestDb();
  await db.insert(users).values({
    id: "user_1",
    name: "User One",
    email: "user@example.com",
    normalizedEmail: "user@example.com",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await seedPersonalSpace(db, "user_1", { now: NOW });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function insertBoard(syncNodeId: string | null, syncGeneration = 0) {
  await db.insert(whiteboards).values({
    id: "wb_1",
    syncRoomId: "wb_1",
    syncNodeId,
    syncGeneration,
    spaceId: "user_1_space",
    title: "Board",
    status: "active",
    createdByUserId: "user_1",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function boardRow() {
  return db.query.whiteboards.findFirst({ where: { id: "wb_1" }, columns: { syncNodeId: true, syncGeneration: true } });
}

/** An open Meeting on `mediaNodeId` showing the board. */
async function showInMeeting(meetingId: string, mediaNodeId: string) {
  await db.insert(meetingLinks).values({
    id: `link_${meetingId}`,
    code: `abc-defg-${meetingId.slice(-3)}`,
    spaceId: "user_1_space",
    spaceKind: "personal",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(meetings).values({
    id: meetingId,
    meetingLinkId: `link_${meetingId}`,
    spaceId: "user_1_space",
    spaceKind: "personal",
    startedByUserId: "user_1",
    status: "open",
    billingPrincipalType: "user",
    billingPrincipalId: "user_1",
    billingPlan: "free",
    mediaNodeId,
    startedAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(meetingWhiteboards).values({
    id: `usage_${meetingId}`,
    meetingId,
    spaceId: "user_1_space",
    whiteboardId: "wb_1",
    attachedAt: NOW,
  });
}

describe("placeBoard", () => {
  it("gives a board with no node yet the one nearest its editor", async () => {
    await insertBoard(null);

    const placement = await placeBoard(db, env(), "wb_1", { kind: "editor", latencies: FROM_LONDON });

    expect(placement).toMatchObject({ node: { id: "ams1" }, generation: 1 });
    expect(await boardRow()).toEqual({ syncNodeId: "ams1", syncGeneration: 1 });
    expect(received).toEqual([]);
  });

  it("keeps a board where it is for an editor it is fast for", async () => {
    await insertBoard("sg1", 3);

    const placement = await placeBoard(db, env(), "wb_1", { kind: "editor", latencies: FROM_SINGAPORE });

    expect(placement).toMatchObject({ node: { id: "sg1" }, generation: 3 });
    expect(received).toEqual([]);
  });

  it("moves an idle board to an editor another node is much faster for, once its node confirms no one is on it", async () => {
    await insertBoard("sg1", 3);

    const placement = await placeBoard(db, env(), "wb_1", { kind: "editor", latencies: FROM_LONDON });

    expect(received).toEqual([{
      node: "sg1",
      name: "handoff",
      body: { whiteboardRoomId: "meet-wb_1", whiteboardId: "wb_1", generation: 3, ifIdle: true },
    }]);
    expect(placement).toMatchObject({ node: { id: "ams1" }, generation: 4 });
  });

  it("keeps a board someone is using where it is, for an editor another node is faster for", async () => {
    await insertBoard("sg1", 3);
    handoff = () => Response.json({ ok: false, reason: "busy", message: "Someone is using this whiteboard here" }, { status: 409 });

    const placement = await placeBoard(db, env(), "wb_1", { kind: "editor", latencies: FROM_LONDON });

    expect(placement).toMatchObject({ node: { id: "sg1" }, generation: 3 });
    expect(await boardRow()).toEqual({ syncNodeId: "sg1", syncGeneration: 3 });
  });

  it("keeps a board a live Meeting shows, for an editor another node is faster for", async () => {
    await insertBoard("sg1", 3);
    await showInMeeting("mtg_other", "sg1");

    expect(await placeBoard(db, env(), "wb_1", { kind: "editor", latencies: FROM_LONDON })).toMatchObject({ node: { id: "sg1" } });
    expect(received).toEqual([]);
  });

  it("moves a board to a Meeting's node: its node hands it off, and it goes up a generation", async () => {
    await insertBoard("sg1", 3);

    const placement = await placeBoard(db, env(), "wb_1", { kind: "meeting", meetingId: "mtg_1", mediaNodeId: "ams1" });

    expect(received).toEqual([{
      node: "sg1",
      name: "handoff",
      body: { whiteboardRoomId: "meet-wb_1", whiteboardId: "wb_1", generation: 3 },
    }]);
    expect(placement).toMatchObject({ node: { id: "ams1" }, generation: 4 });
    expect(await boardRow()).toEqual({ syncNodeId: "ams1", syncGeneration: 4 });
  });

  it("leaves a board with another live Meeting on its node", async () => {
    await insertBoard("sg1", 3);
    await showInMeeting("mtg_other", "sg1");

    const placement = await placeBoard(db, env(), "wb_1", { kind: "meeting", meetingId: "mtg_1", mediaNodeId: "ams1" });

    expect(placement).toMatchObject({ node: { id: "sg1" }, generation: 3 });
    expect(received).toEqual([]);
  });

  it("keeps a board whose node answered but could not save it", async () => {
    await insertBoard("sg1", 3);
    handoff = () => Response.json({ ok: false, reason: "unavailable", message: "Whiteboard state could not be saved" }, { status: 503 });

    const placement = await placeBoard(db, env(), "wb_1", { kind: "meeting", meetingId: "mtg_1", mediaNodeId: "ams1" });

    expect(placement).toMatchObject({ node: { id: "sg1" }, generation: 3 });
    expect(await boardRow()).toEqual({ syncNodeId: "sg1", syncGeneration: 3 });
  });

  it("moves a board off a node that cannot be reached", async () => {
    await insertBoard("sg1", 3);
    handoff = () => {
      throw new TypeError("fetch failed");
    };

    const placement = await placeBoard(db, env(), "wb_1", { kind: "meeting", meetingId: "mtg_1", mediaNodeId: "ams1" });

    expect(placement).toMatchObject({ node: { id: "ams1" }, generation: 4 });
  });

  it("moves a board off a node that is down without asking it, to the node nearest its editor", async () => {
    await insertBoard("ams1", 3);
    await recordFailures("ams1", "whiteboard", 5);

    const placement = await placeBoard(db, env(), "wb_1", { kind: "editor", latencies: FROM_SINGAPORE });

    expect(received).toEqual([]);
    expect(placement).toMatchObject({ node: { id: "sg1" }, generation: 4 });
  });

  it("keeps a board on a node whose LiveKit is down: only its sync server's health counts", async () => {
    await insertBoard("ams1", 3);
    await recordFailures("ams1", "media", 5);

    expect(await placeBoard(db, env(), "wb_1", { kind: "editor", latencies: FROM_LONDON })).toMatchObject({ node: { id: "ams1" } });
    expect(received).toEqual([]);
  });

  it("moves a board off a retiring node when someone opens it, but not for a command", async () => {
    const retiring = env({ sg1: node("sg1", 0) });
    await insertBoard("sg1", 3);

    expect(await placeBoard(db, retiring, "wb_1", { kind: "service" })).toMatchObject({ node: { id: "sg1" }, generation: 3 });
    expect(await placeBoard(db, retiring, "wb_1", { kind: "editor", latencies: FROM_SINGAPORE }))
      .toMatchObject({ node: { id: "ams1" }, generation: 4 });
  });

  it("answers null for a board with no row", async () => {
    await expect(placeBoard(db, env(), "wb_missing", { kind: "service" })).resolves.toBeNull();
  });
});

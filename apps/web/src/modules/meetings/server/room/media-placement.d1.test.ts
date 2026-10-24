import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  meetingAdmissions,
  meetingConnections,
  meetingLinks,
  meetings,
  nodeHealth,
  users,
} from "@orbmeet/db/schema";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";
import type { NodeLatencies } from "@orbmeet/nodes";
import type { MediaNode } from "@/platform/realtime/nodes";

// Each node's LiveKit as the Worker reaches it: which nodes answer, the rooms
// they report, and what the Worker asks them to close.
const livekit = vi.hoisted(() => ({
  reachable: new Set<string>(),
  rooms: {} as Record<string, string[]>,
  removed: [] as string[],
  deleted: [] as string[],
}));

vi.mock("@/platform/realtime/livekit-clients.server", () => ({
  createRoomServiceClient: (node: MediaNode) => ({
    listRooms: async () => {
      if (!livekit.reachable.has(node.id)) throw new Error(`${node.id} unreachable`);
      return (livekit.rooms[node.id] ?? []).map((name) => ({ name }));
    },
    listParticipants: async () => [{ identity: "stranded" }],
    removeParticipant: async (room: string, identity: string) => {
      livekit.removed.push(`${node.id}/${room}/${identity}`);
    },
    deleteRoom: async (room: string) => {
      livekit.deleted.push(`${node.id}/${room}`);
    },
  }),
}));

const { checkMediaNodes, choosePlacement } = await import("./media-placement.server");

/** The node placement chooses for a Meeting as it stands in D1. */
async function placeMeeting(
  database: typeof db,
  config: Pick<Env, "NODES">,
  meetingId: string,
  options: { unreachableMediaUrl?: string; latencies?: NodeLatencies; now: Date },
) {
  const meeting = await database.query.meetings.findFirst({ where: { id: meetingId }, columns: { mediaNodeId: true } });
  const node = await choosePlacement(database, config, meeting?.mediaNodeId ?? null, options.unreachableMediaUrl ?? null, options.latencies ?? {}, options.now);
  return { node };
}

const NOW = new Date("2026-09-25T10:00:00.000Z");

/** A media node's NODES entry. */
function mediaNode(id: string, options: { weight?: number; capacity?: number; region?: string } = {}) {
  return {
    ...(options.region === undefined ? {} : { region: options.region }),
    ...(options.weight === undefined ? {} : { weight: options.weight }),
    media: { url: `wss://${id}.rtc.example.com`, capacity: options.capacity ?? 100, keys: { [`${id}-key`]: `${id}-secret` } },
  };
}

// Two nodes the joiners in these tests reach equally fast: load decides.
const env = {
  NODES: JSON.stringify({
    sg1: mediaNode("sg1", { weight: 2 }),
    my1: mediaNode("my1"),
  }),
};

let db: TestDb;
let linkCount = 0;

beforeEach(async () => {
  livekit.reachable = new Set();
  livekit.rooms = {};
  livekit.removed = [];
  livekit.deleted = [];
  db = await createTestDb();
  linkCount = 0;
  await db.insert(users).values({
    id: "host",
    name: "Host",
    email: "host@example.com",
    normalizedEmail: "host@example.com",
    plan: "free",
    role: "user",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await seedPersonalSpace(db, "host", { now: NOW });
});

async function insertMeeting(
  id: string,
  options: {
    mediaNodeId?: string | null;
    activeEgressId?: string | null;
    liveParticipants?: number;
    connectionStatus?: "pending" | "live";
  } = {},
) {
  await db.insert(meetingLinks).values({
    id: `link_${id}`,
    // Link codes are letters only.
    code: `abc-defg-${String.fromCharCode(97 + linkCount++)}aa`,
    spaceId: "host_space",
    spaceKind: "personal",
    allowGuests: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(meetings).values({
    id,
    meetingLinkId: `link_${id}`,
    spaceId: "host_space",
    spaceKind: "personal",
    startedByUserId: "host",
    status: "open",
    billingPrincipalType: "user",
    billingPrincipalId: "host",
    billingPlan: "free",
    allowGuests: true,
    recordingEnabled: true,
    mediaNodeId: options.mediaNodeId ?? null,
    activeEgressId: options.activeEgressId ?? null,
    startedAt: NOW,
    updatedAt: NOW,
  });
  for (let index = 0; index < (options.liveParticipants ?? 0); index++) {
    const connectionId = `${id}_conn_${index}`;
    await db.insert(meetingAdmissions).values({
      id: `${connectionId}_admission`,
      meetingId: id,
      subjectType: "guest",
      guestSecretHash: "hash",
      displayName: connectionId,
      admissionStatus: "approved",
      decidedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(meetingConnections).values({
      id: connectionId,
      meetingId: id,
      admissionId: `${connectionId}_admission`,
      livekitIdentity: connectionId,
      role: "attendee",
      connectionStatus: options.connectionStatus ?? "live",
      tokenIssuedAt: NOW,
      connectedAt: options.connectionStatus === "pending" ? null : NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

async function recordProbes(failures: Record<string, number>) {
  for (const [nodeId, count] of Object.entries(failures)) {
    await db.insert(nodeHealth).values({ nodeId, service: "media", checkedAt: NOW, failures: count });
  }
}

async function failuresOf(nodeId: string) {
  const [row] = await db.select().from(nodeHealth)
    .where(and(eq(nodeHealth.nodeId, nodeId), eq(nodeHealth.service, "media")));
  return row?.failures;
}

describe("choosePlacement", () => {
  it("places a new Meeting on the node with the lowest load for its weight", async () => {
    await recordProbes({ sg1: 0, my1: 0 });
    // sg1 carries 3 (one Meeting, two participants) at weight 2 = 1.5;
    // my1 carries 2 at weight 1 = 2.
    await insertMeeting("mtg_on_sg1", { mediaNodeId: "sg1", liveParticipants: 2 });
    await insertMeeting("mtg_on_my1", { mediaNodeId: "my1", liveParticipants: 1 });
    await insertMeeting("mtg_new");

    const room = await placeMeeting(db, env, "mtg_new", { now: NOW });

    expect(room.node.id).toBe("sg1");
  });

  it("keeps a Meeting on its node through one failed probe, but places no new one there", async () => {
    await recordProbes({ sg1: 1, my1: 0 });
    await insertMeeting("mtg_1", { mediaNodeId: "sg1", liveParticipants: 1 });
    await insertMeeting("mtg_new");

    expect((await placeMeeting(db, env, "mtg_1", { now: NOW })).node.id).toBe("sg1");
    expect((await placeMeeting(db, env, "mtg_new", { now: NOW })).node.id).toBe("my1");
  });

  it("moves a Meeting off a node that is down", async () => {
    // Its participants still read as live: the dead node sent no departures.
    await recordProbes({ sg1: 2, my1: 0 });
    await insertMeeting("mtg_1", {
      mediaNodeId: "sg1",
      activeEgressId: "EG_lost",
      liveParticipants: 2,
    });

    const room = await placeMeeting(db, env, "mtg_1", { now: NOW });

    expect(room.node.id).toBe("my1");
  });

  it("keeps a down Meeting's node when it answers the probe of last resort", async () => {
    // A blip between Cloudflare and both nodes marked them down, while clients
    // on sg1 may never have lost it.
    livekit.reachable = new Set(["sg1", "my1"]);
    await recordProbes({ sg1: 2, my1: 2 });
    await insertMeeting("mtg_1", { mediaNodeId: "sg1", liveParticipants: 3 });
    // my1 carries less, so a fresh choice would move the Meeting there.
    await insertMeeting("mtg_new");

    expect((await placeMeeting(db, env, "mtg_1", { now: NOW })).node.id).toBe("sg1");
  });

  it("moves a Meeting whose node has left the configuration", async () => {
    await recordProbes({ sg1: 0 });
    await insertMeeting("mtg_1", { mediaNodeId: "retired" });

    expect((await placeMeeting(db, env, "mtg_1", { now: NOW })).node.id).toBe("sg1");
  });

  it("keeps a weight-0 node's Meetings but gives it no new ones", async () => {
    const retiring = {
      NODES: JSON.stringify({
        sg1: mediaNode("sg1", { weight: 0 }),
        my1: mediaNode("my1"),
      }),
    };
    await recordProbes({ sg1: 0, my1: 0 });
    await insertMeeting("mtg_1", { mediaNodeId: "sg1", liveParticipants: 1 });
    await insertMeeting("mtg_on_my1", { mediaNodeId: "my1", liveParticipants: 20 });
    await insertMeeting("mtg_new");

    expect((await placeMeeting(db, retiring, "mtg_1", { now: NOW })).node.id).toBe("sg1");
    expect((await placeMeeting(db, retiring, "mtg_new", { now: NOW })).node.id).toBe("my1");
  });

  it("moves the Meeting at once when the node a client could not reach fails its probe too", async () => {
    livekit.reachable = new Set(["my1"]);
    await recordProbes({ sg1: 0, my1: 0 });
    await insertMeeting("mtg_1", { mediaNodeId: "sg1", liveParticipants: 3 });

    const room = await placeMeeting(db, env, "mtg_1", {
      unreachableMediaUrl: "wss://sg1.rtc.example.com",
      now: NOW,
    });

    expect(room.node.id).toBe("my1");
    expect(await failuresOf("sg1")).toBe(1);
  });

  it("keeps the Meeting through one failed minutely probe when no client reports trouble", async () => {
    await recordProbes({ sg1: 1, my1: 0 });
    await insertMeeting("mtg_1", { mediaNodeId: "sg1", liveParticipants: 3 });

    expect((await placeMeeting(db, env, "mtg_1", { now: NOW })).node.id).toBe("sg1");
  });

  it("sends the client back when the node it reported answers the probe", async () => {
    livekit.reachable = new Set(["sg1", "my1"]);
    await recordProbes({ sg1: 1, my1: 0 });
    await insertMeeting("mtg_1", { mediaNodeId: "sg1", liveParticipants: 3 });

    const room = await placeMeeting(db, env, "mtg_1", {
      unreachableMediaUrl: "wss://sg1.rtc.example.com",
      now: NOW,
    });

    expect(room.node.id).toBe("sg1");
    expect(await failuresOf("sg1")).toBe(0);
  });

  it("probes only the Meeting's own node, whatever URL a client names", async () => {
    await recordProbes({ sg1: 0, my1: 0 });
    await insertMeeting("mtg_1", { mediaNodeId: "sg1" });

    await placeMeeting(db, env, "mtg_1", { unreachableMediaUrl: "wss://my1.rtc.example.com", now: NOW });

    expect(await failuresOf("my1")).toBe(0);
    expect(await failuresOf("sg1")).toBe(0);
  });

  it("probes every node when none is known to be healthy", async () => {
    livekit.reachable = new Set(["my1"]);
    await insertMeeting("mtg_new");

    expect((await placeMeeting(db, env, "mtg_new", { now: NOW })).node.id).toBe("my1");
    expect(await failuresOf("sg1")).toBe(1);
    expect(await failuresOf("my1")).toBe(0);
  });

  it("refuses when no node answers", async () => {
    await insertMeeting("mtg_new");

    await expect(placeMeeting(db, env, "mtg_new", { now: NOW })).rejects.toMatchObject({
      code: "MEDIA_UNAVAILABLE",
    });
  });

});

describe("choosePlacement by latency", () => {
  // Each node's latency as measured for a joiner: by their browser, or from the data centre they came in through.
  const LONDON = { sg1: 170, sg2: 172, ams1: 8 };
  const DHAKA = { sg1: 40, sg2: 44, ams1: 160 };
  const located = {
    NODES: JSON.stringify({
      sg1: mediaNode("sg1"),
      sg2: mediaNode("sg2"),
      ams1: mediaNode("ams1"),
    }),
  };

  it("places a new Meeting on the node fastest for the joiner, however loaded", async () => {
    await recordProbes({ sg1: 0, sg2: 0, ams1: 0 });
    await insertMeeting("mtg_on_ams1", { mediaNodeId: "ams1", liveParticipants: 9 });
    await insertMeeting("mtg_new");

    expect((await placeMeeting(db, located, "mtg_new", { latencies: LONDON, now: NOW })).node.id).toBe("ams1");
  });

  it("lets load choose among nodes about equally fast", async () => {
    await recordProbes({ sg1: 0, sg2: 0, ams1: 0 });
    await insertMeeting("mtg_on_sg1", { mediaNodeId: "sg1", liveParticipants: 2 });
    await insertMeeting("mtg_new");

    expect((await placeMeeting(db, located, "mtg_new", { latencies: DHAKA, now: NOW })).node.id).toBe("sg2");
  });

  it("goes to the next fastest node when the fastest is down", async () => {
    await recordProbes({ sg1: 0, sg2: 0, ams1: 2 });
    await insertMeeting("mtg_new");

    expect(["sg1", "sg2"]).toContain(
      (await placeMeeting(db, located, "mtg_new", { latencies: LONDON, now: NOW })).node.id,
    );
  });

  it("lets load choose among every node when nothing was measured", async () => {
    await recordProbes({ sg1: 0, sg2: 0, ams1: 0 });
    await insertMeeting("mtg_on_sg1", { mediaNodeId: "sg1" });
    await insertMeeting("mtg_on_sg2", { mediaNodeId: "sg2" });
    await insertMeeting("mtg_new");

    expect((await placeMeeting(db, located, "mtg_new", { now: NOW })).node.id).toBe("ams1");
  });

  it("goes to a slower node only once every fast one is full", async () => {
    const small = {
      NODES: JSON.stringify({
        sg1: mediaNode("sg1", { capacity: 5 }),
        ams1: mediaNode("ams1", { capacity: 5 }),
      }),
    };
    await recordProbes({ sg1: 0, ams1: 0 });
    // sg1 carries 4 (one Meeting, three participants): room for one more.
    await insertMeeting("mtg_on_sg1", { mediaNodeId: "sg1", liveParticipants: 3 });
    await insertMeeting("mtg_new");
    expect((await placeMeeting(db, small, "mtg_new", { latencies: DHAKA, now: NOW })).node.id).toBe("sg1");

    await insertMeeting("mtg_also_on_sg1", { mediaNodeId: "sg1" });
    await insertMeeting("mtg_newer");
    expect((await placeMeeting(db, small, "mtg_newer", { latencies: DHAKA, now: NOW })).node.id).toBe("ams1");
  });

  it("lets load choose between a region's nodes, however differently a VPN measured them", async () => {
    const regions = {
      NODES: JSON.stringify({
        sg1: mediaNode("sg1", { region: "sin" }),
        sg2: mediaNode("sg2", { region: "sin" }),
        ams1: mediaNode("ams1", { region: "ams" }),
      }),
    };
    // A Dhaka browser behind a VPN: Singapore's second machine 50 ms slower than its first.
    const viaVpn = { sg1: 70, sg2: 120, ams1: 190 };
    await recordProbes({ sg1: 0, sg2: 0, ams1: 0 });
    await insertMeeting("mtg_on_sg1", { mediaNodeId: "sg1", liveParticipants: 4 });
    await insertMeeting("mtg_new");

    expect((await placeMeeting(db, regions, "mtg_new", { latencies: viaVpn, now: NOW })).node.id).toBe("sg2");
    // Measured the same way but with no regions, 50 ms apart are two places.
    expect((await placeMeeting(db, located, "mtg_new", { latencies: viaVpn, now: NOW })).node.id).toBe("sg1");
  });

  it("keeps an open Meeting on its node wherever a later joiner is", async () => {
    await recordProbes({ sg1: 0, sg2: 0, ams1: 0 });
    await insertMeeting("mtg_1", { mediaNodeId: "sg1", liveParticipants: 1 });

    expect((await placeMeeting(db, located, "mtg_1", { latencies: LONDON, now: NOW })).node.id).toBe("sg1");
  });
});

describe("checkMediaNodes", () => {
  it("records each probe and fails while any node does not answer", async () => {
    livekit.reachable = new Set(["my1"]);
    await recordProbes({ sg1: 1, my1: 3 });

    await expect(checkMediaNodes(db, env, NOW)).rejects.toThrow("Media nodes failed their probe: sg1");

    expect(await failuresOf("sg1")).toBe(2);
    expect(await failuresOf("my1")).toBe(0);
  });

  it("records a node's first failed probe without failing: one is often a blip", async () => {
    livekit.reachable = new Set(["my1"]);
    await recordProbes({ sg1: 0, my1: 0 });

    await checkMediaNodes(db, env, NOW);

    expect(await failuresOf("sg1")).toBe(1);
  });

  it("closes a room a node still holds for a Meeting that moved away", async () => {
    livekit.reachable = new Set(["sg1", "my1"]);
    livekit.rooms = { sg1: ["meet-mtg_moved", "meet-mtg_home", "meet-mtg_ended", "unrelated"] };
    await insertMeeting("mtg_moved", { mediaNodeId: "my1" });
    await insertMeeting("mtg_home", { mediaNodeId: "sg1" });

    await checkMediaNodes(db, env, NOW);

    expect(livekit.removed).toEqual(["sg1/meet-mtg_moved/stranded"]);
    expect(livekit.deleted).toEqual(["sg1/meet-mtg_moved"]);
  });

  it("looks up however many rooms a node holds, past one statement's parameter limit", async () => {
    livekit.reachable = new Set(["sg1", "my1"]);
    const rooms = Array.from({ length: 150 }, (_, index) => `meet-mtg_${index}`);
    livekit.rooms = { sg1: rooms };
    await insertMeeting("mtg_149", { mediaNodeId: "my1" });

    await checkMediaNodes(db, env, NOW);

    expect(livekit.deleted).toEqual(["sg1/meet-mtg_149"]);
  });

  it("closes a room recreated for a drained Meeting, and leaves teardown to a Meeting still ending", async () => {
    livekit.reachable = new Set(["sg1", "my1"]);
    livekit.rooms = { sg1: ["meet-mtg_drained", "meet-mtg_ending", "meet-mtg_home", "meet-mtg_elsewhere"] };
    await insertMeeting("mtg_drained", { mediaNodeId: "sg1" });
    await insertMeeting("mtg_ending", { mediaNodeId: "sg1" });
    await insertMeeting("mtg_home", { mediaNodeId: "sg1" });
    await db.update(meetings)
      .set({ status: "ended", endedAt: NOW, drainedAt: NOW })
      .where(eq(meetings.id, "mtg_drained"));
    await db.update(meetings)
      .set({ status: "ended", endedAt: NOW })
      .where(eq(meetings.id, "mtg_ending"));

    await checkMediaNodes(db, env, NOW);

    // `mtg_elsewhere` has no row here: possibly another deployment's room.
    expect(livekit.deleted).toEqual(["sg1/meet-mtg_drained"]);
    expect(livekit.removed).toEqual([]);
  });
});


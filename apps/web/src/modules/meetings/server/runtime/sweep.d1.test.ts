import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:workers";
import { meetingLinks, meetings, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@/test/db";
import { seedPersonalSpace } from "@/test/fixtures";

const woken = vi.hoisted(() => [] as string[]);
vi.mock("./client.server", () => ({
  callCoordinator: async (_env: unknown, request: { meetingId: string }) => {
    woken.push(request.meetingId);
    return { kind: "ok" };
  },
}));

const { sweepQuietMeetings } = await import("./sweep.server");

// A sweep tick: minutes divisible by ten.
const NOW = new Date("2026-07-01T12:00:00.000Z");
const LONG_AGO = new Date(NOW.getTime() - 60 * 60_000);
let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  woken.length = 0;
  await db.insert(users).values({
    id: "host", name: "Host", email: "host@example.com", normalizedEmail: "host@example.com",
    plan: "free", role: "user", createdAt: LONG_AGO, updatedAt: LONG_AGO,
  });
  await seedPersonalSpace(db, "host", { now: LONG_AGO });
});

let links = 0;
/** A distinct meeting-link code, letters only. */
function nextCode(): string {
  const n = links++;
  const letter = (value: number) => String.fromCharCode(97 + (value % 26));
  return `abc-d${letter(Math.floor(n / 26))}${letter(n)}g-hij`;
}

async function seedOpenMeetings(ids: string[], firstJoinedAt: Date | null) {
  for (const id of ids) {
    await db.insert(meetingLinks).values({
      id: `link_${id}`, code: nextCode(), spaceId: "host_space", spaceKind: "personal",
      allowGuests: true, createdAt: LONG_AGO, updatedAt: LONG_AGO,
    });
    await db.insert(meetings).values({
      id, meetingLinkId: `link_${id}`, spaceId: "host_space", spaceKind: "personal",
      startedByUserId: "host", status: "open", billingPrincipalType: "user", billingPrincipalId: "host",
      billingPlan: "free", allowGuests: true, recordingEnabled: false, joinPolicy: "open",
      startedAt: LONG_AGO, firstJoinedAt, updatedAt: LONG_AGO,
    });
  }
}

describe("sweepQuietMeetings", () => {
  it("wakes every quiet open meeting, joined or not, and nothing recently active", async () => {
    await seedOpenMeetings(["meeting_live"], new Date(LONG_AGO.getTime() + 1_000));
    await seedOpenMeetings(["meeting_orphan"], null);
    await db.update(meetings).set({ updatedAt: NOW }).where(eq(meetings.id, "meeting_orphan"));
    await seedOpenMeetings(["meeting_quiet_orphan"], null);

    await sweepQuietMeetings({ DB: testEnv.DB } as unknown as Env, NOW);

    expect(new Set(woken)).toEqual(new Set(["meeting_live", "meeting_quiet_orphan"]));
  });

  it("reaches every orphan over successive ticks, however many rows cannot be woken", async () => {
    const orphans = Array.from({ length: 60 }, (_, index) => `meeting_${String(index).padStart(4, "0")}`);
    await seedOpenMeetings(orphans, null);

    // None of these wakes ends a meeting, the worst case for a fixed order.
    for (let tick = 0; tick < 20; tick += 1) {
      await sweepQuietMeetings({ DB: testEnv.DB } as unknown as Env, NOW);
    }

    expect(new Set(woken)).toEqual(new Set(orphans));
  });
});

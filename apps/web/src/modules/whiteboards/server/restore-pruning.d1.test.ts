import { afterEach, expect, it, vi } from "vitest";
import { meetingLinks, meetings, meetingWhiteboards, users, whiteboardRevisions } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/test/db";
import { seedMeetingWhiteboard, seedPersonalSpace } from "@/test/fixtures";
import { boundedStatements } from "@/platform/database/db-batching";
import {
  snapshotMeta,
  installFakeSyncServer,
} from "@/test/fake-sync-server";
import { TEST_WHITEBOARD_D1_ENV } from "@/test/whiteboard-d1-env";
import { restoreWhiteboardFromRevision } from "./restores";
import { withInlineJobs } from "@/test/jobs";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedMeeting(status: "open" | "ended" = "open") {
  const db = await createTestDb();
  const now = new Date("2026-07-19T00:00:00.000Z");
  await db.insert(users).values({
    id: "user_host",
    name: "Host",
    email: "host@example.com",
    normalizedEmail: "host@example.com",
    createdAt: now,
    updatedAt: now,
  });
  await seedPersonalSpace(db, "user_host", { now });
  await db.insert(meetingLinks).values({
    id: "link_1",
    code: "abc-defg-hij",
    spaceId: "user_host_space",
spaceKind: "personal" as const,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: "meeting_1",
    meetingLinkId: "link_1",
    spaceId: "user_host_space",
    spaceKind: "personal" as const,
    title: "Product review",
    startedByUserId: "user_host",
    status,
    billingPrincipalType: "user" as const,
    billingPrincipalId: "user_host",
    billingPlan: "free",
    startedAt: now,
    endedAt: status === "ended" ? now : null,
    updatedAt: now,
  });
  return { db, now };
}

function fakeR2(initial: Record<string, string> = {}) {
  const objects = new Map(Object.entries(initial));
  const customMetadata = new Map<string, Record<string, string>>();
  return {
    objects,
    customMetadata,
    bucket: {
      async get(key: string) {
        const value = objects.get(key);
        if (value === undefined) return null;
        const bytes = new TextEncoder().encode(value);
        return {
          size: bytes.byteLength,
          customMetadata: customMetadata.get(key),
          arrayBuffer: async () => bytes.buffer,
          text: async () => value,
        };
      },
      async head(key: string) {
        const value = objects.get(key);
        return value === undefined ? null : { size: new TextEncoder().encode(value).byteLength };
      },
      async put(key: string, value: ArrayBuffer, options?: R2PutOptions) {
        objects.set(key, new TextDecoder().decode(value));
        if (options?.customMetadata) customMetadata.set(key, options.customMetadata);
      },
      async delete(key: string) {
        objects.delete(key);
      },
    } as unknown as R2Bucket,
  };
}

it("preserves meeting pins while rotating the unpinned restore budget",async()=>{
    const { db, now } = await seedMeeting("ended");
    const snapshot = JSON.stringify({ documents: [] });
    const stored = Object.fromEntries([
      ["internal/whiteboards/whiteboard_1/state/current.json", snapshot],
      ...Array.from({ length: 25 }, (_, index) => [
        `whiteboards/whiteboard_1/revisions/restore-${index + 1}.json`,
        snapshot,
      ]),
    ]);
    const r2 = fakeR2(stored);
    await seedMeetingWhiteboard(db, {
      whiteboardId: "whiteboard_1",
      meetingId: "meeting_1",
      spaceId: "user_host_space",
      title: "Calculus",
      now,
    });
    const restoreRevisions = Array.from({ length: 25 }, (_, index) => ({
      id: `rev_restore_${index + 1}`,
      whiteboardId: "whiteboard_1",
      spaceId: "user_host_space",
      revisionNumber: index + 1,
      kind: "pre_restore" as const,
      snapshotR2Key: `whiteboards/whiteboard_1/revisions/restore-${index + 1}.json`,
      snapshotSize: snapshot.length,
      createdAt: new Date(now.getTime() + index * 1_000),
    }));
    for (const insert of boundedStatements(restoreRevisions, (chunk) => db.insert(whiteboardRevisions).values(chunk))) {
      await insert;
    }


    await db.update(meetingWhiteboards).set({captureStatus:"captured",capturedRevisionId:"rev_restore_1",capturedAt:now}).where(eq(meetingWhiteboards.meetingId,"meeting_1"));
    let clock = 10;
    installFakeSyncServer({
      readSnapshot: ({ key }) => ({
        ok: true,
        snapshot: JSON.parse(snapshot),
        meta: snapshotMeta(key, { documentClock: clock }),
      }),
      restore: (request) => {
        r2.objects.set(request.restorePointKey, snapshot);
        clock += 1;
        return {
          ok: true,
          restorePoint: snapshotMeta(request.restorePointKey, { documentClock: clock }),
        };
      },
    });
    const env = { ...TEST_WHITEBOARD_D1_ENV, R2_BUCKET: r2.bucket } as unknown as Env;
    for(let attempt=0;attempt<2;attempt++) {
      const result=await restoreWhiteboardFromRevision(db, withInlineJobs(env),{whiteboardId:"whiteboard_1",revisionId:"rev_restore_25",userId:"user_host",now});
      expect(typeof result.restorePointRevisionId).toBe("string");
    }
    const revisions=await db.query.whiteboardRevisions.findMany({where:{whiteboardId:"whiteboard_1",kind:"pre_restore"}});
    expect(revisions).toHaveLength(26);
    expect(revisions.some(r=>r.id==="rev_restore_1")).toBe(true);
});


// Shared construction for the Meeting Whiteboard document tests.

import {
  meetingLinks,
  meetings,
  users,
} from "@orbmeet/db/schema";

import { createTestDb } from "@/test/db";

import { seedPersonalSpace } from "@/test/fixtures";

import {
  captureMeetingWhiteboardUsageRevision,
} from "@/modules/whiteboards/server/document-revisions";

import {
  emulatedSyncServer,
  installFakeSyncServer,
  type ReceivedCommand,
} from "@/test/fake-sync-server";
import { TEST_WHITEBOARD_D1_ENV } from "@/test/whiteboard-d1-env";

export async function seedMeeting(status: "open" | "ended" = "open") {
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

export function fakeR2(initial: Record<string, string> = {}) {
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

export type FakeR2 = ReturnType<typeof fakeR2>;

const syncEnvs = new WeakMap<FakeR2, { env: Env; commands: ReceivedCommand[]; rooms: Map<string, string> }>();

/**
 * The Worker's env with a sync server emulated over `r2`. One per bucket, so
 * every call in a test shares the same server (and its document clock).
 */
export function syncServer(r2: FakeR2) {
  let server = syncEnvs.get(r2);
  if (!server) {
    const rooms = new Map<string, string>();
    const { commands } = installFakeSyncServer(emulatedSyncServer(r2.objects, rooms));
    server = {
      env: { ...TEST_WHITEBOARD_D1_ENV, R2_BUCKET: r2.bucket } as unknown as Env,
      commands,
      rooms,
    };
    syncEnvs.set(r2, server);
  }
  return server;
}

export function syncEnv(r2: FakeR2): Env {
  return syncServer(r2).env;
}

/** Each board's live state on the emulated sync node, by whiteboard id. */
export function rooms(r2: FakeR2): Map<string, string> {
  return syncServer(r2).rooms;
}

/** A pin deadline that has not passed. */
export const inTime = () => Date.now() + 60_000;

export async function captureMeetingWhiteboardRevision(
  db: Awaited<ReturnType<typeof createTestDb>>,
  env: Env,
  meetingId: string,
  now = new Date(),
): Promise<string | null> {
  const usages = await db.query.meetingWhiteboards.findMany({
    where: { meetingId },
    columns: { id: true },
  });
  let firstRevisionId: string | null = null;
  for (const usage of usages) {
    const revisionId = await captureMeetingWhiteboardUsageRevision(
      db,
      env,
      usage.id,
      now,
    );
    firstRevisionId ??= revisionId;
  }
  return firstRevisionId;
}

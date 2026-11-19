/**
 * Whether a Space's meetings begin transcribed. Meeting defaults come from the
 * Space, never from whoever opens it: the meeting reads this when it starts
 * (`meeting-occurrence.ts`), and only the Space's admins change it.
 */

import type { Database } from "@orbmeet/db";
import { spaces } from "@orbmeet/db/schema";
import { and, eq } from "drizzle-orm";
import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { Errors } from "@/lib/app-errors";
import { getRunChanges } from "@/platform/database/db-utils";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import type { setSpaceTranscriptionSchema } from "@/modules/spaces/contract/schemas";
import { assertSpaceCapability, getSpaceAccess, retainsSpaceManagerSql } from "./helpers";
import { ensurePersonalSpace } from "./personal";

export interface SpaceTranscription {
  spaceId: string;
  on: boolean;
}

async function readSpaceTranscription(db: Database, spaceId: string): Promise<SpaceTranscription | null> {
  const space = await db.query.spaces.findFirst({
    where: { id: spaceId },
    columns: { transcribeMeetings: true },
  });
  return space ? { spaceId, on: space.transcribeMeetings } : null;
}

/** The Space's default for someone who may change it; null for anyone else. */
export async function manageableSpaceTranscription(
  db: Database,
  spaceId: string,
  userId: string,
): Promise<SpaceTranscription | null> {
  const access = await getSpaceAccess(db, spaceId, userId);
  return access?.capabilities.canManage ? readSpaceTranscription(db, spaceId) : null;
}

/** The default of the caller's personal Space: the meetings they hold on their own link. */
export async function getPersonalSpaceTranscriptionImpl({
  context: { user, db },
}: {
  context: AuthFnContext;
}): Promise<SpaceTranscription> {
  const spaceId = await ensurePersonalSpace(db, user);
  const transcription = await readSpaceTranscription(db, spaceId);
  if (!transcription) throw Errors.NOT_FOUND("Space");
  return transcription;
}

export async function setSpaceTranscriptionImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof setSpaceTranscriptionSchema>;
  context: AuthFnContext;
}): Promise<SpaceTranscription> {
  await enforceRateLimit(env, `space:transcription:${user.id}`);
  await assertSpaceCapability(db, data.spaceId, user.id, "canManage");
  const result = await db
    .update(spaces)
    .set({ transcribeMeetings: data.on, updatedAt: new Date() })
    .where(and(eq(spaces.id, data.spaceId), retainsSpaceManagerSql(data.spaceId, user.id)));
  if (getRunChanges(result) === 0) {
    throw Errors.FORBIDDEN("Your Space role changed before the update completed.");
  }
  return { spaceId: data.spaceId, on: data.on };
}

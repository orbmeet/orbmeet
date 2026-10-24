import "@tanstack/react-start/server-only";

import type * as v from "valibot";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { Errors } from "@/lib/app-errors";
import { logError } from "@/lib/logger";
import type { deleteSpaceSchema } from "@/modules/spaces/contract/schemas";
import { requestSpaceDeletion } from "@/modules/spaces/server/deletion.server";
import { assertSpaceCapability } from "@/modules/spaces/server/helpers";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { startJob } from "@/platform/jobs/jobs";

export async function deleteSpaceImpl({
  data,
  context: { user, env, db },
}: {
  data: v.InferOutput<typeof deleteSpaceSchema>;
  context: AuthFnContext;
}) {
  // H4: rate-limit space deletion (triggers LiveKit teardown + R2 deletes)
  await enforceRateLimit(env, `space:delete:${user.id}`);

  await assertSpaceCapability(db, data.spaceId, user.id, "canDelete");

  const requested = await requestSpaceDeletion(db, data.spaceId, user.id);
  if (!requested) {
    throw Errors.VALIDATION("Space ownership changed before deletion started. Please retry.");
  }

  // The Space is archived and closed to everyone; the purge job removes it
  // and its contents durably (see cleanup.server.ts). Should the Workflow be
  // unreachable, the daily sweep starts it.
  try {
    await startJob(env, { kind: "purgeSpace", spaceId: data.spaceId, requestedAt: Date.now() });
  } catch (err) {
    logError("[spaces] Could not start the purge of an archived space", { spaceId: data.spaceId }, err);
  }

  return { success: true };
}

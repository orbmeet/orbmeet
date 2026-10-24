/**
 * Server implementations behind the RPC declarations in ./index.ts.
 */
import "@tanstack/react-start/server-only";
import type { AuthFnContext } from "@/app/bootstrap/middleware";
import { getPlanLimits } from "@/modules/billing/contract/plan-limits";
import { getUserStoredBytes } from "./storage";

export async function getMyStorageUsageImpl({ context: { user, db } }: { context: AuthFnContext }) {
  const usedBytes = await getUserStoredBytes(db, user.id);
  const limits = getPlanLimits(user.plan ?? "free");
  return { usedBytes, maxBytes: limits.maxStorageBytes };
}

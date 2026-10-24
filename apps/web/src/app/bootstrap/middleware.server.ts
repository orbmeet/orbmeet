import "@tanstack/react-start/server-only";

import { createDb } from "@orbmeet/db";
import { Errors } from "@/lib/app-errors";
import { getCloudflareCtx, getEnv } from "@/platform/runtime/server-runtime.server";
import {
  getAccountDeletionSessionFromRequest,
  getAuthenticatedUser,
  getSessionFromRequest,
} from "@/modules/identity/server/session";
import { getClientIP } from "@/platform/http/client-ip.server";
import { enforceRateLimit } from "@/platform/http/rate-limit.server";
import { addLogContext } from "@/platform/runtime/log-context";
import type { AuthFnContext, RequestFnContext } from "./middleware";

export async function resolveRequestContext(
  preAuthRateLimitPrefix?: string,
): Promise<RequestFnContext> {
  const env = await getEnv();
  const clientIP = getClientIP();
  if (preAuthRateLimitPrefix) {
    await enforceRateLimit(env, `${preAuthRateLimitPrefix}:${clientIP}`);
  }
  const user = await getAuthenticatedUser();
  if (user) addLogContext({ userId: user.id });
  return {
    env,
    db: createDb(env.DB),
    executionCtx: getCloudflareCtx(),
    clientIP,
    user,
  };
}

export async function resolveAuthContext(
  allowAccountDeletionResume: boolean,
): Promise<AuthFnContext> {
  const [env, session] = await Promise.all([
    getEnv(),
    allowAccountDeletionResume ? getAccountDeletionSessionFromRequest() : getSessionFromRequest(),
  ]);
  if (!session?.user) throw Errors.UNAUTHORIZED();
  addLogContext({ userId: session.user.id });

  return {
    env,
    db: createDb(env.DB),
    executionCtx: getCloudflareCtx(),
    clientIP: getClientIP(),
    user: session.user,
    authSessionId: session.id,
  };
}

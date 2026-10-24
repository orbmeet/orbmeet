import type { CoordinatorReply, CoordinatorRequest } from "@/modules/meetings/server/runtime/api";
import { TEST_MEDIA_ENV } from "./nodes";

const requests: CoordinatorRequest[] = [];

/**
 * Stands in for `callCoordinator` in tests of code that tells a meeting's
 * coordinator what happened. Install it in the test file:
 *
 *   vi.mock("@/modules/meetings/server/runtime/client.server", async (original) => ({
 *     ...(await original<object>()),
 *     callCoordinator: (await import("@/test/coordinator")).recordCoordinatorRequest,
 *   }));
 */
export async function recordCoordinatorRequest(_env: Env, request: CoordinatorRequest): Promise<CoordinatorReply> {
  requests.push(request);
  return { kind: "ok" };
}

/** A fresh record of coordinator requests, and an Env to pass along. */
export function fakeCoordinatorEnv(): { env: Env; requests: CoordinatorRequest[] } {
  requests.length = 0;
  return { env: { ...TEST_MEDIA_ENV } as unknown as Env, requests };
}

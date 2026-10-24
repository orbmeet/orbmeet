import { logError } from "@/lib/logger";
import { getOrCreateRequestId, withRequestIdHeader } from "@/platform/http/request-id";
import { secureApiResponse } from "@/platform/http/security-headers";
import { enablesHsts, validateProductionConfig } from "./request-policy";

/**
 * Every `/api/`, `/_serverFn/` and root server-route request, from arrival to
 * the response the Worker sends.
 *
 * Two route tables answer here. The whiteboard table goes first: it serves the
 * sync server's callbacks and the board's asset reads, and dispatches each to
 * its own handler without loading Start's server graph. Everything else is a
 * Start server route or server function. Whichever answers, the response is
 * finished once, below — the same security headers, cache default, HSTS and
 * request id for all of them.
 *
 * Both graphs load on first use, so a request needs only its own.
 */
export async function handleApiRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const requestId = getOrCreateRequestId(request);
  const finish = (response: Response) =>
    secureApiResponse(response, { requestId, enableHSTS: enablesHsts(env) });

  const configError = validateProductionConfig(env);
  if (configError) return finish(configError);

  const tagged = withRequestIdHeader(request, requestId);
  const { pathname } = new URL(tagged.url);
  try {
    if (pathname.startsWith("/api/")) {
      const { whiteboardFetchHandler } = await import("@/modules/whiteboards/server/http/handler");
      const response = await whiteboardFetchHandler(tagged, env, pathname);
      if (response) return finish(response);
    }
    const { handleStartApiRequest } = await import("../../server");
    return finish(await handleStartApiRequest(tagged, env, ctx));
  } catch (error) {
    // Each table maps the failures it expects; this is the one that escaped.
    logError("[api] Request failed", { method: tagged.method }, error);
    return finish(Response.json({ error: "Internal error" }, { status: 500 }));
  }
}

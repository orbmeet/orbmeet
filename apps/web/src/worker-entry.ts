import { handleApiRequest } from "./app/bootstrap/api-request";
import { logError, setLogContext } from "@/lib/logger";
import { RECORDINGS_QUEUE_NAME } from "@/modules/meetings/server/media/recordings-queue";
import { getOrCreateRequestId, withRequestIdHeader } from "@/platform/http/request-id";
import { currentLogContext, withLogContext } from "@/platform/runtime/log-context";

// Every line the Worker logs, its Durable Objects and Workflows included,
// carries the invocation it belongs to.
setLogContext(currentLogContext);

// Static assets, including the prerendered public pages, are served before
// this Worker runs (cloudflare.config.ts `assets`). What reaches it is an API
// request, a page Start renders according to its route's `ssr` option, or a
// file Assets does not have. Both server graphs load on first use, so a cold
// isolate pays for the one it needs.

type EnvWithAssets = Env & {
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
};

// Start server routes may live outside /api. Keep the exceptional public
// endpoints explicit so every other path is treated as a page or a file.
const ROOT_SERVER_ROUTE_PATHS = new Set(["/llms.txt"]);

export function isStartServerRequestPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_serverFn/") ||
    ROOT_SERVER_ROUTE_PATHS.has(pathname)
  );
}

/**
 * A path naming a file (its last segment has an extension) rather than a
 * page. No route's path has one, so a miss here is a missing file, answered by
 * Assets rather than by rendering the app's not-found page.
 */
export function isFilePath(pathname: string): boolean {
  return pathname.slice(pathname.lastIndexOf("/") + 1).includes(".");
}

/** `/_serverFn/` names no function: a scanner's probe, which Start would answer with a 500. */
function isBareServerFunctionPath(pathname: string): boolean {
  return pathname === "/_serverFn" || pathname === "/_serverFn/";
}

export function fetchRequest(
  request: Request,
  env: EnvWithAssets,
  ctx: ExecutionContext,
): Promise<Response> {
  // Tagged once here, so the id this invocation logs is the one its response returns.
  const requestId = getOrCreateRequestId(request);
  const tagged = withRequestIdHeader(request, requestId);
  const { pathname } = new URL(tagged.url);
  const server = isStartServerRequestPath(pathname);
  return withLogContext({
    requestId,
    rayId: tagged.headers.get("CF-Ray") ?? undefined,
    // Only server paths: a page's path can carry a secret, such as an invite token.
    path: server ? pathname : undefined,
  }, async () => {
    try {
      return await route(tagged, pathname, server, env, ctx);
    } catch (error) {
      // Cloudflare's own per-request line is off (cloudflare.config.ts), so
      // what escapes is recorded here; the runtime still answers it.
      logError("[worker] Request failed", error);
      throw error;
    }
  });
}

async function route(
  request: Request,
  pathname: string,
  server: boolean,
  env: EnvWithAssets,
  ctx: ExecutionContext,
): Promise<Response> {
  if (isBareServerFunctionPath(pathname)) return new Response("Not found", { status: 404 });

  if (server) {
    return handleApiRequest(request, env, ctx);
  }

  if (isFilePath(pathname)) {
    return env.ASSETS?.fetch(request) ?? new Response("Not found", { status: 404 });
  }

  const { handleDocumentRequest } = await import("./server");
  return handleDocumentRequest(request, env, ctx);
}

/** Each open meeting's single writer; see modules/meetings/server/runtime/meeting-room.ts. */
export { MeetingRoom } from "@/modules/meetings/server/runtime/meeting-room";
/** The Workflow background jobs run in; see platform/jobs/jobs.ts. */
export { DurableJobWorkflow } from "@/app/jobs/durable-job-workflow";
/** One queue per scope for work that must not overlap; see app/serial/tasks.ts. */
export { SerialScope } from "@/app/serial/serial-scope";

const worker: ExportedHandler<EnvWithAssets> = {
  fetch: fetchRequest,
  scheduled(controller, env) {
    return withLogContext({ cron: controller.cron }, async () => {
      const { runScheduled } = await import("./app/bootstrap/scheduled.server");
      await runScheduled(controller.cron, env, new Date(controller.scheduledTime));
    });
  },
  queue(batch, env) {
    return withLogContext({ queue: batch.queue }, async () => {
      if (batch.queue !== RECORDINGS_QUEUE_NAME) throw new Error(`No consumer for queue ${batch.queue}`);
      const { registerUploadedRecordings } = await import("@/modules/meetings/server/media/recordings.server");
      await registerUploadedRecordings(batch, env);
    });
  },
};

export default worker;

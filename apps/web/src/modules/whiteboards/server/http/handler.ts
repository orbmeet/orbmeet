import { MATHINK_RECOGNIZE_PATH } from "@orbmeet/whiteboard-core/mathink-constants";
import {
  CODE_RUN_CANCEL_PATH,
  CODE_RUN_PATH,
} from "@orbmeet/whiteboard-core/code-run-contract";
import { AppError } from "@/lib/app-errors";
import { handleRunCode, handleCancelCodeRun } from "@/modules/whiteboards/server/http/run-code";
import { handleRoomAuthority } from "@/modules/whiteboards/server/http/room-authority";
import {
  acceptsSyncProtocol,
  ROOM_AUTHORITY_PATH,
  SYNC_PROTOCOL,
  SYNC_PROTOCOL_HEADER,
  syncCommandFailure,
  syncProtocolOf,
} from "@orbmeet/whiteboard-core/sync-commands";
import { handlePdfUpload } from "@/modules/whiteboards/server/http/whiteboard-pdf-upload";
import { handlePdfImportGrant } from "@/modules/whiteboards/server/http/whiteboard-pdf-import-grant";
import { handleRecorderAuth } from "@/modules/whiteboards/server/http/recorder-auth";
import { handleWbAssets } from "@/modules/whiteboards/server/http/wb-assets";
import { handleAuthenticatedMathInkRequest } from "@/modules/whiteboards/server/mathink/proxy";
import { logError } from "@/lib/logger";
import { validateCsrfOrigin } from "@/platform/http/origin-validation";

/**
 * The whiteboard's API routes, or null when `pathname` is none of them.
 *
 * Kept dependency-light: each route imports only its own handler, so a small
 * asset request does not evaluate the AI, PDF, Drizzle, or schema graphs.
 * The caller (app/bootstrap/api-request.ts) finishes every response.
 */
export async function whiteboardFetchHandler(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  try {
    return await dispatchWhiteboardRoute(request, env, pathname);
  } catch (error) {
    // A curated `AppError` is a decision, not a failure — a rate-limit refusal
    // most of all, which a 500 would tell the sync server to treat as
    // "infrastructure down" and allow through on stale authorization.
    if (error instanceof AppError) {
      return Response.json({ error: error.message }, { status: error.statusCode });
    }
    // 500 is the correct signal here — the sync server maps it to a bounded
    // stale-allow ("infrastructure down"), while definitive denials are the
    // handlers' job to express as 2xx/4xx responses.
    logError("[whiteboard-api] Request failed", { method: request.method }, error);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/**
 * How a route's caller proves who it is. `bearer`: a whiteboard token in the
 * Authorization header. `signed`: a request the sync server signed. `browser`:
 * the app's session or asset cookie, which a browser attaches to any site's
 * request, so every non-GET browser route must also come from the app's own
 * origin; the table enforces that, not each handler.
 */
type RouteAuth = "bearer" | "signed" | "browser";

interface Route {
  /** Null for a route that answers every method itself. */
  method: "GET" | "POST" | null;
  path: string;
  /** Match every path under `path`, not only `path` itself. */
  prefix?: boolean;
  auth: RouteAuth;
  handle: (request: Request, env: Env, pathname: string) => Promise<Response>;
}

const WB_ASSETS_PREFIX = "/api/wb-assets/";

const ROUTES: readonly Route[] = [
  { method: "POST", path: CODE_RUN_PATH, auth: "bearer", handle: handleRunCode },
  { method: "POST", path: CODE_RUN_CANCEL_PATH, auth: "bearer", handle: handleCancelCodeRun },
  { method: "POST", path: ROOM_AUTHORITY_PATH, auth: "signed", handle: handleRoomAuthority },
  { method: "POST", path: "/api/whiteboard/pdf-upload", auth: "browser", handle: handlePdfUpload },
  { method: "POST", path: "/api/whiteboard/pdf-import-grant", auth: "signed", handle: handlePdfImportGrant },
  { method: "POST", path: "/api/whiteboard/recorder-auth", auth: "browser", handle: handleRecorderAuth },
  {
    method: "GET", path: WB_ASSETS_PREFIX, prefix: true, auth: "browser",
    handle: (request, env, pathname) => handleWbAssets(request, env, pathname.slice(WB_ASSETS_PREFIX.length)),
  },
  { method: null, path: MATHINK_RECOGNIZE_PATH, auth: "bearer", handle: handleAuthenticatedMathInkRequest },
];

async function dispatchWhiteboardRoute(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  const route = ROUTES.find((candidate) =>
    (candidate.prefix ? pathname.startsWith(candidate.path) : pathname === candidate.path)
    && (candidate.method === null || candidate.method === request.method));
  if (!route) return null;
  // A sync server's call speaks the protocol its build does; one this Worker
  // cannot read is refused as such, not misread (see SYNC_PROTOCOL).
  if (route.auth === "signed") {
    const spoken = syncProtocolOf(request.headers.get(SYNC_PROTOCOL_HEADER));
    if (!acceptsSyncProtocol(SYNC_PROTOCOL, spoken)) {
      logError("[whiteboard-api] A sync server called speaking another protocol", { protocol: spoken ?? "unreadable" });
      return Response.json(
        syncCommandFailure("incompatible", `This app accepts sync protocol ${SYNC_PROTOCOL.accepts.oldest}–${SYNC_PROTOCOL.accepts.newest}`),
        { status: 426 },
      );
    }
  }
  if (
    route.auth === "browser"
    && request.method !== "GET"
    && !validateCsrfOrigin(request, { appUrl: env.APP_URL, environment: env.ENVIRONMENT })
  ) {
    return new Response("Forbidden: CSRF origin validation failed", { status: 403 });
  }
  return route.handle(request, env, pathname);
}

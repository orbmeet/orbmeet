import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";
import type { CloudflareContext } from "@/platform/runtime/cloudflare-context";
import { addPrivateHtmlSecurityHeaders, addSecurityHeaders } from "@/platform/http/security-headers";
import { validateCsrfOrigin } from "@/platform/http/origin-validation";
import { getOrCreateRequestId, withRequestId, withRequestIdHeader } from "@/platform/http/request-id";
import { logError } from "./lib/logger";
import { isPublicDocumentPath } from "./lib/public-routes";
import { tokenIdFromRaw } from "./app/adapters/public-api/bearer-auth";
import { automationApiErrorResponse } from "./app/adapters/public-api/http";
import {
  documentSecurityConfig,
  isAutomationApiPath,
  isCsrfExemptApiPath,
  isDevelopment,
  validateProductionConfig,
} from "./app/bootstrap/request-policy";
import { enforceAutomationPreAuthRateLimit } from "./platform/http/rate-limit.server";
import { getClientIPFromRequest } from "./platform/http/client-ip";
import { deploymentOf } from "./platform/http/deployment";

// Cloudflare's env bindings and ExecutionContext travel through Start's request
// context. Registering the shape here is what makes `handler(request, { context })`
// type-checked and `getGlobalStartContext()` typed at every read site
// (see lib/cloudflare-context.ts).
declare module "@tanstack/react-router" {
  interface Register {
    server: {
      requestContext: CloudflareContext;
    };
  }
}

const handler = createStartHandler(defaultStreamHandler);

type StartRequestOptions = Parameters<typeof handler>[1];

function startRequestOptions(context: CloudflareContext): StartRequestOptions {
  return {
    context,
    // Only static-phase links: the dynamic phase can carry route-specific hints
    // that are not safe to attach to a shared/cacheable response.
    responseLinkHeader: { filter: ({ phase }) => phase === "static" },
  };
}

/**
 * A Start server route or server function. Its response is finished — headers,
 * cache default, request id — by app/bootstrap/api-request.ts, which is the
 * only caller.
 */
export async function handleStartApiRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  const automationAuthorization = request.headers.get("Authorization");
  const automationToken = automationAuthorization?.startsWith("Bearer ")
    ? automationAuthorization.slice("Bearer ".length).trim()
    : "";
  if (isAutomationApiPath(pathname) && !tokenIdFromRaw(automationToken)) {
    try {
      await enforceAutomationPreAuthRateLimit(
        env,
        null,
        getClientIPFromRequest(request, deploymentOf(env)),
      );
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return automationApiErrorResponse(error);
    }
  }

  // Browser cookie APIs require same-origin CSRF proof. The narrowly
  // enumerated v1 surface is bearer-only and authenticates a scoped PAT in
  // every route handler, so command-line clients do not need browser-only
  // Origin/Referer headers.
  //
  // This is the outer of two CSRF layers: server functions are additionally
  // covered by createCsrfMiddleware in src/start.ts. Exemptions for
  // non-browser callers (webhooks, bearer-auth API) live only in
  // isCsrfExemptApiPath — a new webhook route must be added there or it will 403.
  if (
    !isCsrfExemptApiPath(pathname)
    && !validateCsrfOrigin(request, { appUrl: env.APP_URL, environment: env.ENVIRONMENT })
  ) {
    return new Response("Forbidden: CSRF origin validation failed", { status: 403 });
  }

  return handler(request, startRequestOptions({ env, ctx }));
}

/**
 * Render a document through Start, as its route's `ssr` option says.
 *
 * Cloudflare Assets answers every prerendered public page itself, so this sees
 * the build-time prerender, a public page with no artifact, and every app
 * document, in production as in development.
 *
 * Public pages are rendered without a request nonce: their markup becomes a
 * static artifact. Every other document gets a fresh nonce in its stream.
 * Either way the rendering is never shared-cached — Start may have read the
 * request's cookies.
 */
export async function handleDocumentRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const requestId = getOrCreateRequestId(request);
  const configError = validateProductionConfig(env);
  if (configError) return withRequestId(configError, requestId);

  const tagged = withRequestIdHeader(request, requestId);
  const url = new URL(tagged.url);

  let response: Response;
  try {
    response = await handler(tagged, startRequestOptions({ env, ctx }));
  } catch (error) {
    if (!isDevelopment(env)) throw error;
    logError("[server] SSR error in development:", { url: tagged.url }, error);
    return withRequestId(new Response("<!DOCTYPE html><html><body>SSR Error</body></html>", {
      status: 500,
      headers: { "Content-Type": "text/html" },
    }), requestId);
  }

  if (!response.headers.get("Content-Type")?.includes("text/html")) {
    return withRequestId(response, requestId);
  }
  response.headers.set("Cache-Control", "private, no-store");
  const config = documentSecurityConfig(env, url.pathname);
  if (isPublicDocumentPath(url.pathname) && !url.search) {
    return withRequestId(addSecurityHeaders(response, config), requestId);
  }
  // Only the public pages are for crawlers. Every other document is an app
  // screen, and a crawler that does not run JS sees no more than its loading
  // state, so the header says so whatever the route's own head renders.
  response.headers.set("X-Robots-Tag", "noindex");
  return withRequestId(addPrivateHtmlSecurityHeaders(response, config), requestId);
}

// Start's server-entry contract: with a src/server.ts present, Start builds it
// as its entry and expects this default export. The deployed Worker enters
// through worker-entry.ts, which calls the two handlers above with
// Cloudflare's (request, env, ctx) and never reaches this.
export default createServerEntry({
  fetch: (request, opts) => handler(request, opts),
});

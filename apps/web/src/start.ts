import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { isNotFound, isRedirect } from "@tanstack/react-router";

import { AppError, Errors } from "@/lib/app-errors";
import { logError, logWarn } from "@/lib/logger";

// Inner of two CSRF layers: src/server.ts also runs validateCsrfOrigin on all
// /_serverFn/ and /api/ traffic (and owns the webhook/bearer-API exemption
// list). Keep both — this one travels with Start's request pipeline, the outer
// one covers server routes that never enter it.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

/**
 * The line between an error we wrote and one that merely escaped.
 *
 * Start's server handler serializes a caught error's message straight to the
 * client, and the router plugin preserves it verbatim — so a driver's message,
 * a failed `fetch` URL, or a constraint name from a query became part of an API
 * response. `AppError` is the curated surface: every message on it was written
 * to be read by a user. Anything else is an internal detail, logged here with
 * everything a maintainer needs and answered with one generic sentence.
 *
 * Redirects and not-founds are control flow, not failures, and must pass
 * through untouched. So must a thrown `Response`. An `AppError` reaches the
 * client as written, but one of 500 or more is still our failure, so it is
 * logged on its way.
 *
 * Development keeps the original message: there is nobody to protect it from,
 * and the whole value of the message is in the terminal.
 */
const errorBoundaryMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      if (error instanceof AppError) {
        // A 503 asks the caller to try again: pressure to watch, not a defect.
        if (error.statusCode === 503) logWarn(`[serverFn] ${error.code}`, error);
        else if (error.statusCode >= 500) logError(`[serverFn] ${error.code}`, error);
        throw error;
      }
      if (error instanceof Response || isRedirect(error) || isNotFound(error)) {
        throw error;
      }
      logError("[serverFn] Unhandled error", error);
      if (import.meta.env.DEV) throw error;
      throw Errors.INTERNAL();
    }
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  functionMiddleware: [errorBoundaryMiddleware],
}));

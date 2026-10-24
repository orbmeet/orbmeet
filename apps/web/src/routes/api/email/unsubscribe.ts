import { createFileRoute } from "@tanstack/react-router";
import { createDb } from "@orbmeet/db";

import { escapeHtml } from "@/platform/email/html";
import { recordEmailSuppression } from "@/platform/email/suppression.server";
import { readUnsubscribeToken } from "@/platform/email/unsubscribe-token";
import { getOptionalEnv } from "@/platform/runtime/server-runtime.server";
import {
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
  readRequestBodyText,
} from "@/platform/http/request-body";

const MAX_FORM_BYTES = 4 * 1_024;

/**
 * One-click unsubscribe for the `List-Unsubscribe` header on scheduling mail.
 *
 * RFC 8058 clients (Gmail, Yahoo) POST here with no body of interest; a person
 * following the same link in a plain mail client arrives by GET. GET therefore
 * only *renders* a confirmation form and changes nothing — link scanners and
 * mail-client prefetchers follow GETs, and unsubscribing someone because their
 * security appliance previewed the message would be worse than not offering the
 * header at all.
 *
 * See docs/email-service/reference/headers.md.
 */

function page(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)}</title>`
    + `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 24px;color:#171717">`
    + `<h1 style="font-size:20px">${escapeHtml(title)}</h1>${body}</div>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // A page, not an API body: it styles itself inline and posts its form
        // back here. Nothing else may load or run.
        "Content-Security-Policy":
          "default-src 'none'; style-src-attr 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        // Nothing here is cacheable or worth indexing.
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
    },
  );
}

function invalidLink(): Response {
  return page(
    "This unsubscribe link is not valid",
    `<p style="color:#555">The link may have been truncated by your mail client. `
    + `You can also remove yourself by replying to the person who invited you.</p>`,
    400,
  );
}

export async function handleUnsubscribePost(request: Request, env: Env): Promise<Response> {
  if (!env.AUTH_SECRET || !env.DB) return page("Unsubscribe is unavailable", "", 503);
  // One-click senders put the token in the query string they were given; our
  // own confirmation form posts it in the body.
  const queryToken = new URL(request.url).searchParams.get("token");
  let token = queryToken ?? "";
  if (!token) {
    // The form posts one urlencoded field; nothing legitimate is larger.
    try {
      token = new URLSearchParams(await readRequestBodyText(request, MAX_FORM_BYTES)).get("token") ?? "";
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return page("Request too large", "", 413);
      if (error instanceof RequestBodyTimeoutError) return page("Request timed out", "", 408);
      throw error;
    }
  }
  const email = await readUnsubscribeToken(token, env.AUTH_SECRET);
  if (!email) return invalidLink();
  // Idempotent: `recordEmailSuppression` keeps the first reason, so a repeated
  // one-click stays a success rather than a conflict.
  await recordEmailSuppression(createDb(env.DB), { email, reason: "unsubscribed" });
  return page(
    "You're unsubscribed",
    `<p style="color:#555">Orb Meet will no longer send meeting notifications to `
    + `<strong>${escapeHtml(email)}</strong>.</p>`,
    200,
  );
}

export const Route = createFileRoute("/api/email/unsubscribe")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const env = await getOptionalEnv();
        if (!env?.AUTH_SECRET) return page("Unsubscribe is unavailable", "", 503);
        const token = new URL(request.url).searchParams.get("token") ?? "";
        const email = await readUnsubscribeToken(token, env.AUTH_SECRET);
        if (!email) return invalidLink();
        return page(
          "Stop these emails?",
          `<p style="color:#555">Confirm to stop Orb Meet meeting notifications to `
          + `<strong>${escapeHtml(email)}</strong>.</p>`
          + `<form method="post">`
          + `<input type="hidden" name="token" value="${escapeHtml(token)}">`
          + `<button type="submit" style="background:#4f46e5;color:#fff;border:0;`
          + `border-radius:10px;padding:12px 18px;font-weight:600;font-size:15px;`
          + `cursor:pointer">Unsubscribe</button></form>`,
          200,
        );
      },
      POST: async ({ request }) => {
        const env = await getOptionalEnv();
        if (!env) return page("Unsubscribe is unavailable", "", 503);
        return handleUnsubscribePost(request, env);
      },
    },
  },
});

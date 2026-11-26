import "@tanstack/react-start/server-only";

import { createDb } from "@orbmeet/db";
import { users, accounts, verifications } from "@orbmeet/db/schema";
import { eq, and, gte } from "drizzle-orm";
import { normalizeEmail } from "@/modules/identity/contract/auth/email-normalization";
import { generateId } from "@/lib/ids";
import { appendCookies } from "@/platform/http/cookies.server";
import { getEnv, getOptionalEnv } from "@/platform/runtime/server-runtime.server";
import { enforceIpRateLimit } from "@/platform/http/rate-limit.server";
import { sanitizeUser } from "./session";
import { loadUserBilling } from "@/modules/billing/server/entitlements.server";
import { checkDisposableEmail } from "./disposable-email";
import { Errors } from "@/lib/app-errors";
import { sanitizeDisplayName } from "@/lib/sanitize";
import { findOAuthStateCookie } from "./oauth-state";
import {
  exchangeAndVerifyGoogleCode,
  decryptVerifier,
  googleHostsMailbox,
} from "./oauth-google.server";
import { isUniqueConstraintError } from "@/platform/database/db-utils";
import { logInfo } from "@/lib/logger";
import { clearOAuthStateCookies } from "./oauth-cookies";
import { issueBrowserSession } from "./session-issuance";

/** Where a deletion-gated account must land instead of the signed-in app. */
const ACCOUNT_DELETION_PENDING_PATH = "/account/deletion-pending";

export async function handleGoogleCallbackRequest(
  request: Request,
  data: { code: string; state: string },
) {
  const env = (await getOptionalEnv()) ?? (await getEnv());
  const db = createDb(env.DB);

  await enforceIpRateLimit(env, "oauth-callback");

  const expectedStateHash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data.state),
  );
  const expectedHashHex = Array.from(new Uint8Array(expectedStateHash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const cookie = request.headers.get("Cookie") ?? "";
  const stateCookie = findOAuthStateCookie({
    cookie,
    baseName: "oauth_state",
    expectedHashHex,
    options: { appUrl: env.APP_URL, environment: env.ENVIRONMENT },
  });
  if (!stateCookie) {
    throw Errors.OAUTH_ERROR("OAuth state mismatch");
  }
  appendCookies(clearOAuthStateCookies(env, [stateCookie]));

  const consumed = await db
    .delete(verifications)
    .where(
      and(
        eq(verifications.type, "oauth_pkce"),
        eq(verifications.identifier, `oauth:${data.state}`),
        gte(verifications.expiresAt, new Date()),
      ),
    )
    .returning();

  if (consumed.length === 0) throw Errors.OAUTH_ERROR("Invalid or expired OAuth state");
  const oauthVerification = consumed[0];

  let codeVerifier: string;
  try {
    codeVerifier = await decryptVerifier(oauthVerification.value, env.AUTH_SECRET);
  } catch {
    throw Errors.OAUTH_ERROR("Failed to verify OAuth state");
  }

  const payload = await exchangeAndVerifyGoogleCode(
    data.code,
    codeVerifier,
    `${env.APP_URL}/api/auth/callback/google`,
    env,
  );

  const normalized = normalizeEmail(payload.email);
  const existingAccount = await db.query.accounts.findFirst({
    where: {
      RAW: (row) => and(eq(row.providerId, "google"), eq(row.providerAccountId, payload.sub))!,
    },
  });

  let userId: string;

  if (existingAccount) {
    userId = existingAccount.userId;
  } else {
    const existingUser = await db.query.users.findFirst({
      where: { normalizedEmail: normalized },
    });

    if (existingUser) {
      // People forget whether they signed up with an email code or Google.
      // Anyone who reads the mailbox can already sign in with an emailed code,
      // so when Google hosts that mailbox a verified Google sign-in proves the
      // same thing and links on the spot. Otherwise the address was only
      // verified at Google once, and linking stays behind a signed-in session
      // in settings.
      if (!googleHostsMailbox(payload)) {
        throw Errors.ACCOUNT_LINK_REQUIRED(
          "An account already exists for this email. Sign in with your existing method, then link Google from account settings.",
        );
      }
      try {
        await db.insert(accounts).values({
          id: generateId("ACCOUNT"),
          userId: existingUser.id,
          providerId: "google",
          providerAccountId: payload.sub,
        });
        userId = existingUser.id;
        logInfo("[OAuth] Linked a Google account on sign-in", { userId: existingUser.id });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        // Either a concurrent sign-in linked this same Google subject, or the
        // account already has a different Google account linked, which this
        // one must not replace.
        const providerRaceWinner = await db.query.accounts.findFirst({
          where: {
            RAW: (row) =>
              and(eq(row.providerId, "google"), eq(row.providerAccountId, payload.sub))!,
          },
        });
        if (providerRaceWinner?.userId !== existingUser.id) {
          throw Errors.ACCOUNT_LINK_REQUIRED(
            "This account is linked to a different Google account. Sign in with that one or with an email code.",
          );
        }
        userId = existingUser.id;
      }
    } else {
      await checkDisposableEmail(normalized);
      userId = generateId("USER");
      const now = new Date();
      try {
        await db.batch([
            db.insert(users).values({
              id: userId,
              email: payload.email,
              normalizedEmail: normalized,
              name: sanitizeDisplayName(payload.name ?? ""),
              image: payload.picture ?? null,
              role: "user",
              createdAt: now,
              updatedAt: now,
            }),
            db.insert(accounts).values({
              id: generateId("ACCOUNT"),
              userId,
              providerId: "google",
              providerAccountId: payload.sub,
            }),
        ]);
      } catch (error) {
        // Reconcile only through the provider identity. An email row appearing
        // during the creation race is not proof that this Google subject owns
        // it; silently attaching by normalized email would reintroduce the
        // account-takeover path rejected above.
        const providerRaceWinner = await db.query.accounts.findFirst({
          where: {
            RAW: (row) =>
              and(eq(row.providerId, "google"), eq(row.providerAccountId, payload.sub))!,
          },
        });
        if (providerRaceWinner) {
          userId = providerRaceWinner.userId;
        } else {
          const emailRaceWinner = await db.query.users.findFirst({
            where: { normalizedEmail: normalized },
            columns: { id: true },
          });
          if (emailRaceWinner) {
            throw Errors.ACCOUNT_LINK_REQUIRED(
              "An account already exists for this email. Sign in with your existing method, then link Google from account settings.",
            );
          }
          throw error;
        }
      }
    }
  }

  // The lifecycle fence has to be read before the insert statement is built:
  // a gated account fails every ordinary issuance, so it gets the
  // deletion-resume session and a redirect to the recovery page instead of a
  // silent forever-failure.
  const authenticatedUser = await db.query.users.findFirst({
    where: { id: userId },
    columns: { deletionStartedAt: true },
  });
  if (!authenticatedUser) throw Errors.UNAUTHORIZED();
  const deletionPending = authenticatedUser.deletionStartedAt !== null;

  await issueBrowserSession(db, env, request, {
    userId,
    deletionPending,
  });

  const user = await db.query.users.findFirst({
    where: { id: userId },
  });
  if (!user) throw new Error("OAuth sign-in lost its user row");
  const billing = await loadUserBilling(db, user.id);

  // The OAuth redirect allowlist governs app destinations; the recovery page
  // is deliberately not on it, so the gated case overrides the stored binding
  // and the callback route sends the browser straight to the recovery page.
  if (deletionPending) {
    return {
      user: sanitizeUser(user, billing),
      redirectTo: ACCOUNT_DELETION_PENDING_PATH,
      deletionPending,
    };
  }

  let redirectTo: string | null = null;
  try {
    const binding = oauthVerification.data
      ? (JSON.parse(oauthVerification.data) as { version?: unknown; redirectTo?: unknown })
      : null;
    if (binding?.version === 1 && typeof binding.redirectTo === "string") {
      redirectTo = binding.redirectTo;
    }
  } catch {
    // Old or malformed flow metadata falls back to /home at the route boundary.
  }
  return { user: sanitizeUser(user, billing), redirectTo };
}

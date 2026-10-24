import { parseInput } from "@/lib/validation";
import "@tanstack/react-start/server-only";
import { createDb, type Database } from "@orbmeet/db";
import { beginEmailAuthSchema } from "@/modules/identity/contract/auth/schemas";
import { normalizeEmail } from "@/modules/identity/contract/auth/email-normalization";
import { Errors } from "@/lib/app-errors";
import { isEmailConfigured } from "@/platform/email/delivery";
import { getEnv } from "@/platform/runtime/server-runtime.server";
import { getClientIP } from "@/platform/http/client-ip.server";
import { enforceIpRateLimit, enforceRateLimit } from "@/platform/http/rate-limit.server";
import { checkDisposableEmail } from "./disposable-email";
import { createEmailAuthFlow } from "./email-flow";

type EmailAuthResult =
  | { step: "profile"; email: string }
  | { step: "verify"; email: string; mode: "login" | "signup"; flowId: string; flowToken: string };

/** RPC entry: resolves env + DB here so the declaration file stays server-free. */
export async function beginEmailAuthFlow(
  input: { email: string; name?: string },
): Promise<EmailAuthResult> {
  const env = await getEnv();
  return beginEmailAuthentication(createDb(env.DB), env, input);
}

/**
 * Email-first entry intentionally reveals which next step an address needs.
 * Enforce both rate limits before looking up an account, sharing the existing
 * login budgets. Authentication still requires the browser-bound email code.
 */
export async function beginEmailAuthentication(
  db: Database,
  env: Env,
  input: { email: string; name?: string },
): Promise<EmailAuthResult> {
  const data = parseInput(beginEmailAuthSchema, input);
  const normalized = normalizeEmail(data.email);
  await enforceIpRateLimit(env, "login");
  await enforceRateLimit(env, `login:${normalized}:${getClientIP()}`, true);
  if (!isEmailConfigured(env.EMAIL)) {
    throw Errors.CONFIG_ERROR("Email authentication is not configured");
  }

  // Recheck on profile submission: another tab may have created the account.
  // Never overwrite its name or start an undeliverable signup flow in that case.
  const user = await db.query.users.findFirst({
    where: { normalizedEmail: normalized },
    columns: { id: true, email: true },
  });
  if (user) {
    const flow = await createEmailAuthFlow(db, env, {
      type: "otp_login",
      deliveryPurpose: "login",
      deliverySubject: normalized,
      data: { normalizedEmail: normalized, recipientEmail: user.email, userId: user.id },
    });
    // Do not disclose the stored address when the visitor entered an alias.
    return { step: "verify", mode: "login", email: data.email, ...flow };
  }

  await checkDisposableEmail(normalized);
  if (!data.name) return { step: "profile", email: data.email };

  const flow = await createEmailAuthFlow(db, env, {
    type: "otp_signup",
    deliveryPurpose: "signup",
    deliverySubject: normalized,
    data: { name: data.name, normalizedEmail: normalized, recipientEmail: data.email, userId: null },
  });
  return { step: "verify", mode: "signup", email: data.email, ...flow };
}

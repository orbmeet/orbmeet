import { escapeHtml } from "@/platform/email/html";
import { logError } from "../../lib/logger";

/**
 * Structural type for the Cloudflare Email Service `send_email` binding
 * (`env.EMAIL`), kept structural so tests can stand in for it without the
 * workerd runtime types. The message shape mirrors `EmailMessageBuilder`: `to` satisfies the required
 * destination, and `from` always carries a display name.
 */
export interface EmailSendBinding {
  send(message: {
    to: string;
    from: string | { email: string; name: string };
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string | { email: string; name: string };
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

interface EmailAddress {
  email: string;
  name: string;
}

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string | null;
  replyTo?: string | EmailAddress | null;
  /** Allowlisted custom headers. See docs/email-service/reference/headers.md. */
  headers?: Record<string, string>;
}

/**
 * Why a send failed, which decides what the caller should do about it.
 *
 * - `not-configured` — no binding at all; nothing to retry against.
 * - `configuration`  — the sender or the binding's allowlists are wrong. An
 *   operator has to fix it; retrying the same message never helps.
 * - `recipient`      — this address is permanently undeliverable.
 * - `content`        — the message we built is invalid or too large.
 * - `transient`      — provider-side capacity; worth another attempt later.
 */
type EmailFailureKind =
  | "not-configured"
  | "configuration"
  | "recipient"
  | "content"
  | "transient";

/** Reason to record in `email_suppressions`, when the failure blames the address. */
export type EmailSuppressionReason = "bounced" | "provider_suppressed";

export interface EmailDeliveryResult {
  accepted: boolean;
  retryable: boolean;
  failure: EmailFailureKind | null;
  suppression: EmailSuppressionReason | null;
  /** The provider's machine-readable error code, when it gave one. */
  code: string | null;
  error: string | null;
}

const DEFAULT_FROM_EMAIL = "noreply@orbmeet.com";
const DEFAULT_FROM_NAME = "Orb Meet";

/** RFC 5322 caps the subject at 998 characters. */
const MAX_SUBJECT_LENGTH = 998;

/**
 * How each `env.EMAIL.send()` error code maps onto {@link EmailFailureKind}.
 * Codes absent from this table are unknown to us and treated as transient.
 * See docs/email-service/api/send-emails/workers-api.md#error-codes.
 */
const EMAIL_ERROR_KINDS: Record<string, EmailFailureKind> = {
  // Provider-side capacity. The only failures a resend can actually clear.
  E_RATE_LIMIT_EXCEEDED: "transient",
  E_DAILY_LIMIT_EXCEEDED: "transient",
  E_INTERNAL_SERVER_ERROR: "transient",

  // Deployment-level misconfiguration: an unonboarded sending domain, or a
  // recipient outside the binding's `allowed_destination_addresses`.
  E_SENDER_NOT_VERIFIED: "configuration",
  E_SENDER_DOMAIN_NOT_AVAILABLE: "configuration",
  E_RECIPIENT_NOT_ALLOWED: "configuration",

  // Terminal for this address. `E_DELIVERY_FAILED` reaches us only after
  // Cloudflare has run its own soft-bounce retries with exponential backoff and
  // given up, or after a 5xx hard bounce it never retries at all — so it is an
  // outcome, not a pending one. Retrying here re-sends nothing and charges the
  // failure against the <2% hard-bounce reputation target. See
  // docs/email-service/concepts/email-lifecycle.md and
  // docs/email-service/concepts/deliverability.md.
  E_DELIVERY_FAILED: "recipient",
  E_RECIPIENT_SUPPRESSED: "recipient",

  // The message we built is unusable as-is.
  E_VALIDATION_ERROR: "content",
  E_FIELD_MISSING: "content",
  E_TOO_MANY_RECIPIENTS: "content",
  E_TOO_MANY_ATTACHMENTS: "content",
  E_CONTENT_TOO_LARGE: "content",
  E_HEADER_NOT_ALLOWED: "content",
  E_HEADER_USE_API_FIELD: "content",
  E_HEADER_VALUE_INVALID: "content",
  E_HEADER_VALUE_TOO_LONG: "content",
  E_HEADER_NAME_INVALID: "content",
  E_HEADERS_TOO_LARGE: "content",
  E_HEADERS_TOO_MANY: "content",
};

/**
 * Codes that mean this address should not be mailed again. Cloudflare owns the
 * authoritative suppression list but offers no read API, so we mirror what our
 * own sends reveal. See docs/email-service/concepts/suppressions.md.
 */
const EMAIL_SUPPRESSION_REASONS: Record<string, EmailSuppressionReason> = {
  E_DELIVERY_FAILED: "bounced",
  E_RECIPIENT_SUPPRESSED: "provider_suppressed",
};

const NAMED_ADDRESS_RE = /^"?([^"<]+?)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/;

/** C0 controls and DEL — never legal in a header value. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]+/g;

/**
 * Whether transactional email can be sent at all.
 *
 * This can only test that the `send_email` binding is bound. A binding declared
 * in `cloudflare.config.ts` is *always* present — including under local dev
 * without `"remote": true`, where sends are simulated and merely logged. So
 * `true` here means "we have somewhere to hand the message", not "mail will
 * arrive": an unonboarded sending domain surfaces only at send time, as a
 * `configuration` failure. Callers needing that stronger guarantee have to
 * check the delivery result, not this.
 */
export function isEmailConfigured(binding: EmailSendBinding | null | undefined): boolean {
  return Boolean(binding);
}

/**
 * Parse a `From` value such as `Orb Meet <noreply@orbmeet.com>` or a bare
 * address into the structured form the Workers binding prefers. Falls back to
 * the default sender when unset or blank.
 */
export function parseFromAddress(
  value: string | null | undefined,
): { email: string; name: string } {
  let raw = value?.trim() ?? "";
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.slice(1, -1).trim();
  }
  if (!raw) return { email: DEFAULT_FROM_EMAIL, name: DEFAULT_FROM_NAME };
  const match = NAMED_ADDRESS_RE.exec(raw);
  if (match) {
    return { email: match[2].trim(), name: match[1].trim() || DEFAULT_FROM_NAME };
  }
  return { email: raw, name: DEFAULT_FROM_NAME };
}

/**
 * Fold a subject into something a header can hold: no control characters, no
 * line breaks, and inside the RFC 5322 length cap. Subjects carry user-supplied
 * text (meeting titles), and while Cloudflare validates the field itself, a
 * rejected `E_HEADER_VALUE_INVALID` would strand a notification that only
 * needed its whitespace collapsed.
 */
export function sanitizeSubject(subject: string): string {
  const flattened = subject.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
  return flattened.length > MAX_SUBJECT_LENGTH
    ? flattened.slice(0, MAX_SUBJECT_LENGTH).trimEnd()
    : flattened;
}

/**
 * Send email via the Cloudflare Email Service binding.
 * Cloudflare has no provider-side idempotency key; callers own dedup through
 * their D1 delivery leases and claim fencing instead.
 */
export async function sendEmail(
  binding: EmailSendBinding | null | undefined,
  options: SendEmailOptions,
): Promise<boolean> {
  return (await deliverEmail(binding, options)).accepted;
}

export async function deliverEmail(
  binding: EmailSendBinding | null | undefined,
  options: SendEmailOptions,
): Promise<EmailDeliveryResult> {
  if (!binding) {
    return {
      accepted: false,
      retryable: false,
      failure: "not-configured",
      suppression: null,
      code: null,
      error: "Email service is not configured",
    };
  }
  try {
    await binding.send({
      to: options.to,
      from: parseFromAddress(options.from),
      subject: sanitizeSubject(options.subject),
      html: options.html,
      ...(options.text ? { text: options.text } : {}),
      ...(options.replyTo
        ? { replyTo: typeof options.replyTo === "string" ? parseFromAddress(options.replyTo) : options.replyTo }
        : {}),
      ...(options.headers && Object.keys(options.headers).length
        ? { headers: options.headers }
        : {}),
    });
    return {
      accepted: true,
      retryable: false,
      failure: null,
      suppression: null,
      code: null,
      error: null,
    };
  } catch (err) {
    const code = typeof (err as { code?: unknown } | null)?.code === "string"
      ? (err as { code: string }).code
      : null;
    // Log only the machine-readable code, never the error itself: binding error
    // messages echo the offending address and message content back, and this
    // path runs for every recipient we mail.
    if (!code) {
      logError("[email] Cloudflare Email Service request failed", {
        provider: "cloudflare-email",
      });
      return {
        accepted: false,
        retryable: true,
        failure: "transient",
        suppression: null,
        code: null,
        error: "Email provider request failed",
      };
    }
    const failure = EMAIL_ERROR_KINDS[code] ?? "transient";
    logError("[email] Cloudflare Email Service error", {
      provider: "cloudflare-email",
      code,
      failure,
    });
    return {
      accepted: false,
      retryable: failure === "transient",
      failure,
      suppression: EMAIL_SUPPRESSION_REASONS[code] ?? null,
      code,
      error: `Email provider rejected the message (${code})`,
    };
  }
}

/**
 * Headers every message from this app carries.
 *
 * `Auto-Submitted: auto-generated` (RFC 3834) tells the receiving side not to
 * answer with vacation replies or other autoresponders — none of our mail has a
 * mailbox behind it. It is on the Email Service allowlist; see
 * docs/email-service/reference/headers.md.
 */
export const AUTOMATED_EMAIL_HEADERS: Readonly<Record<string, string>> = {
  "Auto-Submitted": "auto-generated",
};

export function buildOtpEmail(
  otp: string,
  purpose: "signup" | "login" | "delete-account" | "security-action",
): { subject: string; html: string; text: string } {
  const safeOtp = escapeHtml(otp);
  const title =
    purpose === "signup" ? "Verify your email" :
    purpose === "delete-account" ? "Confirm account deletion" :
    purpose === "security-action" ? "Confirm security action" :
    "Sign in to Orb Meet";
  const intro =
    purpose === "signup"
      ? "Welcome to Orb Meet! Use the code below to verify your email address."
      : purpose === "delete-account"
      ? "Someone requested to permanently delete your Orb Meet account. Use the code below to confirm. If you did not request this, do not use this code and your account will remain safe."
      : purpose === "security-action"
      ? "Use the code below to confirm the security-sensitive action you just requested. If you did not request it, do not share this code."
      : "Use the code below to sign in to your Orb Meet account.";
  const expiry = "This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.";

  return {
    subject: `${title} — Orb Meet`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="margin-bottom: 8px;">${title}</h2>
        <p style="color: #555;">${intro}</p>
        <div style="background: #f4f4f5; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; font-family: monospace;">${safeOtp}</span>
        </div>
        <p style="color: #888; font-size: 13px;">${expiry}</p>
      </div>
    `,
    text: `${title}\n\n${intro}\n\n${otp}\n\n${expiry}`,
  };
}

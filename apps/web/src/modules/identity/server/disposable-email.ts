import { Errors } from "@/lib/app-errors";

const KNOWN_DISPOSABLE_EMAIL_DOMAINS = new Set([
  "pmdeal.com",
  "temp-mail.org",
  "tempmail.plus",
  "mail.tm",
  "mailinator.com",
  "guerrillamail.com",
  "sharklasers.com",
  "10minutemail.com",
  "yopmail.com",
]);

function getEmailDomain(normalizedEmail: string): string | null {
  const atIndex = normalizedEmail.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === normalizedEmail.length - 1) return null;
  return normalizedEmail.slice(atIndex + 1).trim().toLowerCase();
}

function isKnownDisposableDomain(domain: string): boolean {
  if (KNOWN_DISPOSABLE_EMAIL_DOMAINS.has(domain)) return true;
  for (const candidate of KNOWN_DISPOSABLE_EMAIL_DOMAINS) {
    if (domain.endsWith(`.${candidate}`)) return true;
  }
  return false;
}

/** Reject known disposable domains without an external reputation dependency. */
export async function checkDisposableEmail(normalizedEmail: string): Promise<void> {
  const domain = getEmailDomain(normalizedEmail);
  if (domain && isKnownDisposableDomain(domain)) {
    throw Errors.TEMPORARY_EMAIL();
  }
}

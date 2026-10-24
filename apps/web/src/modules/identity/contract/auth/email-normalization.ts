/**
 * Normalize email for deduplication.
 * - Lowercase
 * - For Gmail: strip dots and +aliases from local part
 * - Only strip +aliases for providers known to support them
 */

// Providers that are known to treat user+tag as an alias of user
const PLUS_ALIAS_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "fastmail.com",
];

/**
 * Collapse a local part to its canonical form, or null when the rules leave
 * nothing behind.
 *
 * `+foo@gmail.com` strips to an empty local part, and returning `@gmail.com`
 * would let unrelated addresses — every alias-only local part, at every
 * gmail-shaped domain — collapse onto one normalized identity. An address the
 * rules cannot canonicalize is normalized as itself instead.
 */
function canonicalLocalPart(local: string, stripDots: boolean): string | null {
  const withoutTag = local.split("+")[0] ?? "";
  const canonical = stripDots ? withoutTag.replace(/\./g, "") : withoutTag;
  return canonical.length > 0 ? canonical : null;
}

export function normalizeEmail(email: string): string {
  const normalized = email.toLowerCase().trim();
  const separator = normalized.indexOf("@");
  if (separator <= 0 || separator !== normalized.lastIndexOf("@")) return normalized;
  const local = normalized.slice(0, separator);
  // A trailing dot is the DNS root label: `gmail.com.` and `gmail.com` are the
  // same host. Strip it so a trailing-dot address canonicalizes to the same
  // identity instead of registering as a separate account.
  const domain = normalized.slice(separator + 1).replace(/\.+$/, "");
  if (!local || !domain) return normalized;

  // Gmail and Google-hosted domains: strip dots and canonicalize to gmail.com
  const gmailDomains = ["gmail.com", "googlemail.com"];
  if (gmailDomains.includes(domain)) {
    const canonical = canonicalLocalPart(local, true);
    return canonical ? `${canonical}@gmail.com` : normalized;
  }

  if (PLUS_ALIAS_DOMAINS.includes(domain)) {
    const canonical = canonicalLocalPart(local, false);
    return canonical ? `${canonical}@${domain}` : normalized;
  }

  return `${local}@${domain}`;
}

/**
 * Canonical form of an address for suppression lookups: lowercased and trimmed,
 * nothing more.
 *
 * Deliberately *not* the identity normalizer in
 * `modules/identity/client/auth/email-normalization`, which also collapses
 * `+tag` aliases and Gmail dots. That is the right rule for deciding whether two
 * addresses are the same account, and the wrong one here: suppression is per
 * mailbox as Cloudflare sees it, and collapsing aliases would let one bounced
 * alias silence every other address that normalizes onto it.
 */
export function normalizeEmailAddress(email: string): string {
  return email.trim().toLocaleLowerCase();
}

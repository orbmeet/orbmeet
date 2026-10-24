import { MEETING_CODE_SOURCE } from "@/modules/meetings/contract/constants";
import { sanitizeInternalRedirect } from "@/modules/identity/contract/safe-redirect";

const INVITE_RE = /^\/join\/[a-zA-Z]{8}\/?$/;
const MEETING_RE = new RegExp(`^/(?:${MEETING_CODE_SOURCE})$`);
const SPACE_RE = /^\/space\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/;

export interface AuthIntent {
  /** Replaces "Welcome to Orb Meet" when the visitor arrived mid-task. */
  title: string;
  lede: string;
}

const DEFAULT_INTENT: AuthIntent = {
  title: "Welcome to Orb Meet",
  lede: "Enter your email to sign in or create an account. No password needed.",
};

/**
 * What the visitor was trying to do before the session gate stopped them.
 *
 * Without it, someone who clicked a colleague's invite lands on a bare "Welcome
 * to Orb Meet" with nothing tying it to the link they followed — the gate runs
 * before `/join/$token`'s own head, so even the tab says "Sign In". Naming the
 * errand costs one line and is the difference between a login wall and a step.
 *
 * Reads the redirect rather than any referrer, and re-sanitises it here so this
 * is safe to call on a raw search param: `sanitizeInternalRedirect` only
 * returns paths from a fixed allowlist, so nothing a stranger puts in the URL
 * can put arbitrary words on the page.
 */
export function resolveAuthIntent(redirect: unknown): AuthIntent {
  const target = sanitizeInternalRedirect(redirect);
  if (!target) return DEFAULT_INTENT;

  const path = target.split(/[?#]/, 1)[0] ?? "";

  if (INVITE_RE.test(path)) {
    return {
      title: "Accept your invitation",
      lede: "Sign in or create an account to see the Space you were invited to. No password needed.",
    };
  }

  if (MEETING_RE.test(path)) {
    return {
      title: "Join the meeting",
      lede: "Sign in or create an account to enter. No password needed.",
    };
  }

  if (SPACE_RE.test(path)) {
    return {
      title: "Open your Space",
      lede: "Sign in or create an account to pick up where the group left off. No password needed.",
    };
  }

  return DEFAULT_INTENT;
}

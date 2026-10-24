import { getRouteApi } from "@tanstack/react-router";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { finishPasskeyAuthentication, startPasskeyAuthentication } from "@/modules/identity/server/passkey.functions";
import { beginEmailAuth } from "@/modules/identity/server/begin-email-auth.functions";
import { getGoogleAuthUrl } from "@/modules/identity/server/oauth-google.functions";
import { getErrorMessage } from "@/lib/error-inspection";
import { rememberedUserQueryOptions } from "@/app/query-client/queries/session";
import { AuthLayout } from "@/modules/identity/client/components/auth-layout";
import { Button } from "@orbmeet/ui/react";
import { Input } from "@orbmeet/ui/react";
import { resetAuthQueryCache } from "@/modules/identity/client/auth-query-cache";
import { resolveAuthRedirect } from "@/modules/identity/contract/safe-redirect";
import { usePasskeySupport } from "@/lib/hooks/use-passkey-support";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, motion, pressable, stack } from "@orbmeet/ui/styles/atoms";
import { accent, ink, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { ArrowLeft, KeyRound, Mail, User } from "lucide-react";
import { saveClientAuthFlow } from "@/modules/identity/client/auth-flow";
import { resolveAuthIntent } from "@/modules/identity/client/auth-intent";

const routeApi = getRouteApi("/auth");

type FlowStep = "method" | "new";

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  rate_limited: "Too many attempts. Please try again later.",
  oauth_error: "Google sign-in failed. Please try again.",
  auth_failed: "Authentication failed. Please try again.",
  account_link_required:
    "An account already exists for this email. Sign in with your existing method, then link Google from account settings.",
};

/**
 * Deliberately permissive — the emailed code is the real check, so this only
 * has to catch the typo the user can see (a missing `@`, a trailing comma)
 * without rejecting an address the server would have accepted.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

function validateEmail(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "Enter your email address.";
  if (trimmed.length > 320) return "That email address is too long.";
  if (!EMAIL_RE.test(trimmed)) return "That doesn’t look like an email address.";
  return undefined;
}

const styles = stylex.create({

  title: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: "2rem",
    lineHeight: 1.05,
    fontWeight: weight.semibold,
    letterSpacing: "-0.045em",
    color: ink.strong,
  },
  lede: {
    marginTop: space.s2,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  methods: { marginTop: space.s6 },

  /** Buttons that fill the card, with room for a leading glyph. */
  wideButton: { width: "100%", gap: space.s2 },

  divider: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
  },
  dividerRule: { height: space.sPx, flexGrow: 1, backgroundColor: neutral.n200 },
  dividerLabel: { fontSize: text.xs, color: ink.muted },

  fieldIcon: { color: neutral.n500 },

  back: {
    marginBottom: space.s6,
    display: "inline-flex",
    alignItems: "center",
    gap: space.s2,
    fontFamily: "inherit",
    fontSize: text.sm,
    color: { default: ink.muted, [env.hoverable]: { default: ink.muted, ":hover": accent.a700 } },
  },
  createForm: { marginTop: space.s6 },
  legal: {
    marginTop: space.s6,
    marginBottom: 0,
    color: ink.muted,
    fontSize: text.xs,
    // Room between the lines for the links' taller hit areas, so they never overlap.
    lineHeight: { default: leading.base, [env.touch]: 2.5 },
    textAlign: "center",
  },
  /**
   * Inline in a sentence, so a 44px box would break the lines; vertical
   * padding on an inline link grows what a finger hits (16px tall before)
   * without moving the text.
   */
  legalLink: { color: accent.a700, paddingBlock: { default: 0, [env.touch]: 6 } },
});

export function AuthPage() {
  const { redirect: redirectTo, error: oauthError } = routeApi.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<FlowStep>("method");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState(
    oauthError ? (OAUTH_ERROR_MESSAGES[oauthError] ?? "Something went wrong. Please try again.") : ""
  );
  const passkeySupported = usePasskeySupport();

  // What they were doing before the gate stopped them, so the page can say so.
  const intent = resolveAuthIntent(redirectTo);

  const rememberedQuery = useQuery(rememberedUserQueryOptions());

  const emailMutation = useMutation({
    mutationFn: (data: { email: string; name?: string }) => beginEmailAuth({ data }),
    onSuccess: async (result) => {
      setEmail(result.email);
      if (result.step === "profile") {
        setStep("new");
        return;
      }
      saveClientAuthFlow(result.flowId, {
        flowToken: result.flowToken,
        email: result.email,
        mode: result.mode,
      });
      await navigate({
        to: "/verify",
        search: { flowId: result.flowId, redirect: redirectTo },
      });
    },
    onError: (err) => {
      setError(getErrorMessage(err, "Something went wrong. Please try again."));
    },
  });

  const googleMutation = useMutation({
    mutationFn: async () => {
      const { url } = await getGoogleAuthUrl({ data: { redirectTo } });
      window.location.href = url;
    },
    onError: (err) => {
      setError(getErrorMessage(err, "Google sign-in failed. Please try again."));
    },
  });

  const passkeyMutation = useMutation({
    mutationFn: async () => {
      const start = await startPasskeyAuthentication();
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const response = await startAuthentication({ optionsJSON: start.options });
      return finishPasskeyAuthentication({
        data: { challengeId: start.challengeId, response },
      });
    },
    onSuccess: async (result) => {
      await resetAuthQueryCache(queryClient);
      // A deletion-gated account just received the deletion-resume session,
      // not a login; send it to the recovery surface instead of the app.
      if (result.deletionPending) {
        router.history.push("/account/deletion-pending");
        return;
      }
      router.history.push(resolveAuthRedirect(redirectTo));
    },
    onError: (err) => {
      setError(getErrorMessage(err, "Passkey sign-in failed. Use email code instead."));
    },
  });

  const isPending =
    emailMutation.isPending ||
    googleMutation.isPending ||
    passkeyMutation.isPending;

  function resetToMethod() {
    setStep("method");
    setName("");
    setError("");
  }

  function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    const invalid = validateEmail(email);
    setError(invalid ?? "");
    if (invalid) return;
    if (!isPending) emailMutation.mutate({ email });
  }

  function handleRememberedLogin() {
    const remembered = rememberedQuery.data;
    if (!remembered?.email) return;
    setError("");
    setEmail(remembered.email);
    if (!isPending) emailMutation.mutate({ email: remembered.email });
  }

  function handleCreateAccountSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Enter your full name.");
      return;
    }
    setError("");
    if (!isPending) emailMutation.mutate({ name, email });
  }

  return (
    <AuthLayout>
      {step === "method" && (
        <div {...stylex.props(enter.fade)}>
          <h1 {...stylex.props(styles.title)}>{intent.title}</h1>
          <p {...stylex.props(styles.lede)}>{intent.lede}</p>

          <div {...stylex.props(stack.x4, styles.methods)}>
            {rememberedQuery.data && (
              <Button
                type="button"
                variant="secondary"
                sx={styles.wideButton}
                onClick={handleRememberedLogin}
                disabled={isPending}
              >
                <Mail size={16} />
                Continue with {rememberedQuery.data.email}
              </Button>
            )}

            {/* `noValidate`: with `type="email" required` the browser's own bubble
                fires first and wins, so the form had a designed error slot that
                could never be the thing a user saw. Validation is ours now. */}
            <form onSubmit={handleEmailSubmit} noValidate {...stylex.props(stack.x4)}>
              <Input
                label="Email address"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                leftIcon={<Mail size={18} {...stylex.props(styles.fieldIcon)} />}
                error={error || undefined}
                required
                disabled={isPending}
                maxLength={320}
                autoComplete="email"
                autoFocus
              />

              <Button type="submit" sx={styles.wideButton} loading={emailMutation.isPending} disabled={isPending}>
                Continue with email
              </Button>
            </form>

            <div {...stylex.props(styles.divider)}>
              <div {...stylex.props(styles.dividerRule)} />
              <span {...stylex.props(styles.dividerLabel)}>or</span>
              <div {...stylex.props(styles.dividerRule)} />
            </div>

            <Button
              type="button"
              variant="secondary"
              sx={styles.wideButton}
              onClick={() => googleMutation.mutate()}
              disabled={isPending}
            >
              <GoogleIcon />
              Continue with Google
            </Button>

            {passkeySupported && (
              <Button
                type="button"
                variant="ghost"
                sx={styles.wideButton}
                onClick={() => {
                  setError("");
                  passkeyMutation.mutate();
                }}
                disabled={isPending}
              >
                <KeyRound size={16} />
                Sign in with a passkey
              </Button>
            )}

          </div>
        </div>
      )}

      {step === "new" && (
        <div {...stylex.props(enter.fade)}>
          <button
            type="button"
            disabled={isPending}
            onClick={resetToMethod}
            {...stylex.props(pressable.base, motion.tint, focus.ring, styles.back)}
          >
            <ArrowLeft size={16} />
            Use another email
          </button>

          <h1 {...stylex.props(styles.title)}>Create your account</h1>
          <p {...stylex.props(styles.lede)}>
            You’re new here. Add your full name, then we’ll email you a code to confirm your email address.
          </p>

          <form onSubmit={handleCreateAccountSubmit} noValidate {...stylex.props(stack.x4, styles.createForm)}>
            <Input
              label="Full name"
              type="text"
              placeholder="Your full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              leftIcon={<User size={18} {...stylex.props(styles.fieldIcon)} />}
              required
              maxLength={100}
              disabled={isPending}
              autoComplete="name"
              autoFocus
            />
            <Input
              label="Email address"
              type="email"
              placeholder="you@example.com"
              value={email}
              readOnly
              leftIcon={<Mail size={18} {...stylex.props(styles.fieldIcon)} />}
              error={error || undefined}
              required
              autoComplete="email"
            />

            <Button type="submit" sx={styles.wideButton} loading={emailMutation.isPending} disabled={isPending}>
              Create account with email
            </Button>
          </form>
        </div>
      )}
      <p {...stylex.props(styles.legal)}>
        By continuing, you agree to our <Link to="/terms" {...stylex.props(styles.legalLink, focus.ring)}>Terms</Link> and acknowledge our <Link to="/privacy" {...stylex.props(styles.legalLink, focus.ring)}>Privacy Policy</Link>.
      </p>
    </AuthLayout>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.29h6.44a5.5 5.5 0 0 1-2.39 3.61v3h3.88c2.27-2.09 3.56-5.17 3.56-8.63Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.88-3c-1.07.72-2.44 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.95H1.26v3.11A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.3A7.2 7.2 0 0 1 4.9 12c0-.8.14-1.57.37-2.3V6.59H1.26a12 12 0 0 0 0 10.82l4.01-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.76 0 3.34.61 4.58 1.8l3.43-3.43C17.95 1.07 15.23 0 12 0A12 12 0 0 0 1.26 6.59l4.01 3.11c.95-2.84 3.6-4.95 6.73-4.95Z"
      />
    </svg>
  );
}

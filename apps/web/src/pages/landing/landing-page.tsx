import { Link, useRouter } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getErrorMessage,
  getServerErrorCode,
  getServerErrorStatusCode,
} from "@/lib/error-inspection";
import { beginMeetingEntryFlow } from "@/modules/meetings/client/entry-metrics";
import { readCodeInput } from "@/modules/meetings/client/format-code";
import { preloadMeetingRoute } from "@/modules/meetings/client/preload-route";
import { EXAMPLE_MEETING_CODE, MEETING_CODE_REGEX } from "@/modules/meetings/contract/constants";
import { createMeetingLink } from "@/modules/meetings/server/lifecycle/create.functions";
import { sessionQueryOptions } from "@/app/query-client/queries/session";
import { MAIN_CONTENT_ID, SkipLink } from "@/app/shell/skip-link";
import { BrandMark, Spinner } from "@orbmeet/ui/react";
import { focus, layout, motion, pressable, touch } from "@orbmeet/ui/styles/atoms";
import { accent, border, danger, ink, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { LandingFilm } from "./landing-film";

const CREATE_ERROR_FALLBACK = "Failed to create meeting. Please try again.";
const GITHUB_URL = "https://github.com/orbmeet/orbmeet";

function getCreateErrorMessage(error: unknown): string {
  switch (getServerErrorCode(error)) {
    case "PLAN_LIMIT_REACHED":
      return "You've reached your plan's concurrent meeting limit.";
    case "FORBIDDEN":
      return "Your plan doesn't allow this meeting type.";
    case "RATE_LIMITED":
      return "Too many attempts. Please wait a moment and try again.";
    case "CONFLICT":
      return "That meeting code is already taken.";
    default:
      return getErrorMessage(error, CREATE_ERROR_FALLBACK);
  }
}

const FOOTER_LINKS = [
  { to: "/status", label: "Status" },
  { to: "/terms", label: "Terms" },
  { to: "/privacy", label: "Privacy" },
  { to: "/refund", label: "Refunds" },
] as const;

const PLANS = [
  { name: "Free", price: "$0", detail: "100 people, up to 1 h 30 min. The board, notes and Orb included." },
  { name: "Pro", price: "$5", detail: "Per user a month. 500 people, no time limit, cloud recording." },
  { name: "Organization", price: "$10", detail: "Per licensed user a month. Unlimited people and storage, shared billing." },
] as const;

// ─── Styles ──────────────────────────────────────────────────────────────────

/**
 * One white page with one object on it: a film of a single call, which fills
 * whatever the window leaves after the header and the way in. Everyone sees
 * the same page, signed in or not; only the header's last link changes. Light
 * whatever the visitor's own setting; the app follows each person's choice
 * once they have one.
 */
const styles = stylex.create({
  page: {
    colorScheme: "light",
    display: "flex",
    minHeight: "100svh",
    flexDirection: "column",
    backgroundColor: surface.raised,
    color: ink.strong,
    fontFamily: fonts.sans,
    WebkitFontSmoothing: "antialiased",
    overflowX: "clip",
  },
  wrap: {
    width: "100%",
    maxWidth: "78rem",
    marginInline: "auto",
    paddingInline: space.s5,
    boxSizing: "border-box",
  },
  header: { display: "flex", alignItems: "center", gap: space.s2, minHeight: 56 },
  brand: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s2_5,
    marginInlineEnd: "auto",
    color: ink.strong,
    textDecorationLine: "none",
    fontFamily: fonts.heading,
    fontWeight: weight.semibold,
    fontSize: "1.0625rem",
    letterSpacing: "-0.01em",
    borderRadius: 6,
  },
  headerLink: {
    display: "inline-flex",
    alignItems: "center",
    paddingInline: space.s3,
    fontSize: "0.9375rem",
    color: { default: ink.body, [env.hoverable]: { default: ink.body, ":hover": ink.strong } },
    textDecorationLine: "none",
    borderRadius: 8,
  },

  actions: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    columnGap: space.s3,
    rowGap: space.s2,
    marginTop: space.s1,
    marginBottom: space.s3_5,
  },
  start: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s2,
    height: 46,
    paddingInline: space.s7,
    borderWidth: 0,
    borderRadius: 999,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: text.base,
    fontWeight: weight.medium,
    color: ink.onAccent,
    textDecorationLine: "none",
    backgroundColor: { default: accent.a600, [env.hoverable]: { default: accent.a600, ":hover:not(:disabled)": accent.a700 } },
    opacity: { default: 1, ":disabled": 0.7 },
  },
  holding: { cursor: "progress", opacity: 0.6 },
  join: {
    display: "flex",
    alignItems: "center",
    height: 46,
    paddingInlineStart: space.s4,
    paddingInlineEnd: space.s1,
    boxSizing: "border-box",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: border.strong, ":focus-within": accent.a600 },
    borderRadius: 999,
    boxShadow: { default: "none", ":focus-within": `0 0 0 3px ${accent.a100}` },
  },
  joinInput: {
    width: "9.5rem",
    height: 44,
    padding: 0,
    borderWidth: 0,
    outlineStyle: "none",
    fontFamily: "inherit",
    fontSize: text.base,
    color: ink.strong,
    backgroundColor: "transparent",
    "::placeholder": { color: ink.muted },
  },
  joinButton: {
    height: 36,
    paddingInline: space.s3_5,
    borderWidth: 0,
    borderRadius: 999,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "0.9375rem",
    fontWeight: weight.medium,
    color: ink.strong,
    backgroundColor: { default: surface.canvas, [env.hoverable]: { default: surface.canvas, ":hover": surface.board } },
  },
  error: { flexBasis: "100%", margin: 0, textAlign: "center", fontSize: text.sm, color: danger.d600 },

  plans: { display: "flex", flexDirection: "column", gap: "clamp(2rem, 4vw, 3.5rem)", paddingTop: "clamp(4.5rem, 9vw, 8rem)", paddingBottom: "clamp(4.5rem, 9vw, 8rem)" },
  plansTitle: { margin: 0, fontFamily: fonts.heading, fontSize: "clamp(2rem, 4.2vw, 3.375rem)", fontWeight: weight.semibold, lineHeight: 1.05, letterSpacing: "-0.04em" },
  tiers: { display: "flex", flexWrap: "wrap", columnGap: "clamp(2rem, 5vw, 4.5rem)", rowGap: space.s9 },
  tier: { flexGrow: 1, flexShrink: 1, flexBasis: 260, minWidth: 0, display: "flex", flexDirection: "column", gap: space.s2 },
  tierName: { fontSize: text.base, fontWeight: weight.medium, color: ink.body },
  tierPrice: { fontSize: "2.75rem", fontWeight: weight.semibold, lineHeight: 1, letterSpacing: "-0.04em" },
  tierDetail: { margin: 0, marginTop: space.s2, fontSize: text.base, lineHeight: 1.5, color: ink.body },
  compare: { alignSelf: "flex-start", display: "inline-flex", alignItems: "center", fontSize: text.base, fontWeight: weight.medium, color: accent.a700, textDecorationLine: "none", borderRadius: 6 },

  footer: { marginTop: "auto", borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: border.subtle },
  footerRow: { display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: space.s6, paddingBlock: space.s2, fontSize: text.sm, color: ink.muted },
  footerLinks: { display: "flex", flexWrap: "wrap", columnGap: space.s5, marginInlineStart: "auto" },
  footerLink: {
    color: { default: ink.muted, [env.hoverable]: { default: ink.muted, ":hover": ink.strong } },
    textDecorationLine: "none",
    borderRadius: 4,
  },
});

// ─── Pieces ──────────────────────────────────────────────────────────────────

/**
 * Many visitors arrive holding an invitation. A code or a pasted link takes
 * them straight in, without an account.
 */
function JoinWithCode({ onIntent, onError }: { onIntent: () => void; onError: (message: string) => void }) {
  const [code, setCode] = useState("");
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!MEETING_CODE_REGEX.test(code)) {
          setInvalid(true);
          onError(`Enter a code like ${EXAMPLE_MEETING_CODE}, or paste the meeting’s link.`);
          return;
        }
        beginMeetingEntryFlow({ source: "landing-join", code });
        window.location.href = `/${code}`;
      }}
      {...stylex.props(styles.join)}
    >
      <label htmlFor="landing-code" {...stylex.props(layout.srOnly)}>Meeting code or link</label>
      <input
        id="landing-code"
        // A neutral name plus the managers' opt-out attributes: a field
        // labelled as a "code" drew iCloud Passwords' autofill menu.
        name="meeting"
        value={code}
        onChange={(event) => {
          setInvalid(false);
          onError("");
          setCode(readCodeInput(event.target.value));
        }}
        onFocus={onIntent}
        placeholder="Enter a code or link"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        aria-invalid={invalid}
        aria-describedby={invalid ? "landing-error" : undefined}
        {...stylex.props(styles.joinInput)}
      />
      <button type="submit" {...stylex.props(styles.joinButton, motion.tint, focus.ring)}>
        Join
      </button>
    </form>
  );
}

function LandingPlans() {
  return (
    <section aria-labelledby="plans-title" {...stylex.props(styles.wrap, styles.plans)}>
      <h2 id="plans-title" {...stylex.props(styles.plansTitle)}>Start free. Pay when you grow.</h2>
      <div {...stylex.props(styles.tiers)}>
        {PLANS.map((plan) => (
          <div key={plan.name} {...stylex.props(styles.tier)}>
            <span {...stylex.props(styles.tierName)}>{plan.name}</span>
            <strong {...stylex.props(styles.tierPrice)}>{plan.price}</strong>
            <p {...stylex.props(styles.tierDetail)}>{plan.detail}</p>
          </div>
        ))}
      </div>
      <Link to="/pricing" {...stylex.props(touch.target, styles.compare, focus.ring, motion.tint)}>Compare every limit</Link>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer {...stylex.props(styles.footer)}>
      <div {...stylex.props(styles.wrap, styles.footerRow)}>
        <span>Open source, MIT licensed.</span>
        <nav aria-label="Site" {...stylex.props(styles.footerLinks)}>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" {...stylex.props(touch.target, styles.footerLink, focus.ring, motion.tint)}>
            GitHub
          </a>
          {FOOTER_LINKS.map(({ to, label }) => (
            <Link key={to} to={to} {...stylex.props(touch.target, styles.footerLink, focus.ring, motion.tint)}>
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function LandingPage() {
  const { data: session, isLoading: sessionLoading } = useQuery(sessionQueryOptions());
  const signedIn = Boolean(session?.user);
  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState("");
  const router = useRouter();
  const handleMeetingIntent = useCallback(() => {
    preloadMeetingRoute(router).catch(() => {});
  }, [router]);

  const createMutation = useMutation({
    mutationFn: () => createMeetingLink({ data: { allowGuests: true } }),
    onMutate: () => {
      beginMeetingEntryFlow({ source: "landing-create" });
      handleMeetingIntent();
    },
    onSuccess: (result) => {
      // Full page reload required: the server must set meet-route CSP
      // (connect-src includes livekit, Permissions-Policy grants camera/mic).
      // Client-side navigate() preserves the landing page's restrictive headers.
      window.location.href = `/${result.code}`;
    },
    onError: async (error) => {
      const code = getServerErrorCode(error);
      const statusCode = getServerErrorStatusCode(error);
      if (code === "UNAUTHORIZED" || statusCode === 401) {
        await queryClient.invalidateQueries({ queryKey: sessionQueryOptions().queryKey });
        await router.navigate({ to: "/auth", search: { mode: "login" } });
        return;
      }
      setErrorMessage(getCreateErrorMessage(error));
    },
  });

  const { mutate: createMeetingMutate, isPending: createPending } = createMutation;

  const handleCreateMeeting = useCallback(() => {
    if (!session?.user) return;
    setErrorMessage("");
    createMeetingMutate();
  }, [createMeetingMutate, session]);

  /**
   * The one action the page exists for. Signed in it creates a meeting;
   * signed out it goes to auth first; while the session is still resolving it
   * holds its place rather than guessing, because a wrong guess sends someone
   * to the wrong screen.
   */
  const startMeeting = (): ReactNode => {
    if (sessionLoading) {
      return <span {...stylex.props(styles.start, styles.holding)}>Start a meeting, free</span>;
    }
    if (signedIn) {
      return (
        <button
          type="button"
          onPointerEnter={handleMeetingIntent}
          onFocus={handleMeetingIntent}
          onClick={handleCreateMeeting}
          disabled={createPending}
          {...stylex.props(pressable.base, focus.ring, motion.tint, styles.start)}
        >
          {createPending ? <Spinner size="sm" decorative /> : null}
          Start a meeting
        </button>
      );
    }
    return (
      <Link to="/auth" search={{ mode: "login" }} {...stylex.props(styles.start, focus.ring, motion.tint)}>
        Start a meeting, free
      </Link>
    );
  };

  return (
    <div {...stylex.props(styles.page)}>
      <SkipLink />

      <div {...stylex.props(styles.wrap)}>
        <header {...stylex.props(styles.header)}>
          <Link to="/" {...stylex.props(touch.target, styles.brand, focus.ring)}>
            <BrandMark size={24} />
            Orb Meet
          </Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" {...stylex.props(touch.target, styles.headerLink, focus.ring, motion.tint)}>GitHub</a>
          <Link to="/pricing" {...stylex.props(touch.target, styles.headerLink, focus.ring, motion.tint)}>Pricing</Link>
          {sessionLoading ? null : signedIn ? (
            <Link to="/home" {...stylex.props(touch.target, styles.headerLink, focus.ring, motion.tint)}>Open app</Link>
          ) : (
            <Link to="/auth" search={{ mode: "login" }} {...stylex.props(touch.target, styles.headerLink, focus.ring, motion.tint)}>
              Sign in
            </Link>
          )}
        </header>
      </div>

      <main id={MAIN_CONTENT_ID}>
        <h1 {...stylex.props(layout.srOnly)}>Orb Meet: video meetings with a whiteboard, notes and recording</h1>
        <section aria-label="A film of one meeting" {...stylex.props(styles.wrap)}>
          <div {...stylex.props(styles.actions)}>
            {startMeeting()}
            <JoinWithCode onIntent={handleMeetingIntent} onError={setErrorMessage} />
            {errorMessage ? (
              <p role="alert" id="landing-error" {...stylex.props(styles.error)}>{errorMessage}</p>
            ) : null}
          </div>
          <LandingFilm />
        </section>
        <LandingPlans />
      </main>

      <LandingFooter />
    </div>
  );
}

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
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { JumpBackIn } from "./jump-back-in";
import { LatestMeeting } from "./latest-meeting";
import { LandingRoomShot, LandingTour } from "./landing-tour";

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

// ─── Styles ──────────────────────────────────────────────────────────────────

/**
 * One white page. Signed out it walks through a call — the room, getting in,
 * the board, Orb, what is left after — so a first-time visitor knows what
 * they'd be starting. Signed in it is a way back into your rooms and nothing
 * else. Light whatever the visitor's own setting; the app follows each
 * person's choice once they have one.
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
  },
  wrap: {
    width: "100%",
    maxWidth: "70rem",
    marginInline: "auto",
    paddingInline: space.s6,
    boxSizing: "border-box",
  },
  header: { display: "flex", alignItems: "center", gap: space.s2, minHeight: 64 },
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
  openApp: {
    display: "inline-flex",
    alignItems: "center",
    height: 40,
    marginInlineStart: space.s1,
    paddingInline: space.s3_5,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.base,
    borderRadius: 10,
    fontSize: "0.9375rem",
    fontWeight: weight.medium,
    color: ink.strong,
    textDecorationLine: "none",
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": surface.sunken } },
  },

  hero: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    // Short laptop windows still need to see the sample call under the fold
    // line, so the top space shrinks with the viewport's height.
    paddingTop: "clamp(2rem, 7svh, 5rem)",
    textAlign: "center",
  },
  headline: {
    margin: 0,
    maxWidth: "56rem",
    fontFamily: fonts.heading,
    fontWeight: weight.semibold,
    fontSize: "clamp(2.5rem, 4.4vw + 0.25rem, 4rem)",
    lineHeight: 1.04,
    letterSpacing: "-0.045em",
    textWrap: "balance",
  },
  lede: { margin: 0, marginTop: space.s5, maxWidth: "40rem", fontSize: "1.1875rem", lineHeight: 1.55, color: ink.body, textWrap: "pretty" },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    gap: space.s3,
    marginTop: space.s8,
  },
  actionsStart: { justifyContent: "flex-start" },
  start: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s2,
    height: 52,
    paddingInline: space.s6,
    borderWidth: 0,
    borderRadius: 12,
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
    gap: space.s1,
    height: 52,
    paddingInlineStart: space.s4,
    paddingInlineEnd: space.s1,
    boxSizing: "border-box",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: border.base, ":focus-within": accent.a600 },
    borderRadius: 12,
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
    height: 44,
    paddingInline: space.s4,
    borderWidth: 0,
    borderRadius: 9,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: text.base,
    fontWeight: weight.medium,
    color: accent.a700,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": accent.a50 } },
  },
  error: { margin: 0, marginTop: space.s3, fontSize: text.sm, color: danger.d600 },
  fine: { margin: 0, marginTop: space.s3, fontSize: text.sm, color: ink.muted },

  // Signed in: who you are and where you were, beside the last board you used.
  home: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.lg]: "minmax(0, 5fr) minmax(0, 6fr)" },
    alignItems: "start",
    gap: { default: space.s12, [bp.lg]: space.s16 },
    paddingTop: "clamp(2rem, 8svh, 5rem)",
    paddingBottom: space.s24,
  },
  homeWords: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: space.s10 },
  greeting: {
    margin: 0,
    fontFamily: fonts.heading,
    fontWeight: weight.semibold,
    fontSize: "clamp(2.25rem, 3vw + 0.75rem, 3.25rem)",
    lineHeight: 1.05,
    letterSpacing: "-0.04em",
    textWrap: "balance",
  },
  greetingLede: { margin: 0, marginTop: space.s3, fontSize: text.lg, lineHeight: 1.5, color: ink.body },
  homeActions: { marginTop: space.s6 },

  closing: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    paddingBlock: { default: space.s24, [bp.lg]: space.s32 },
    textAlign: "center",
  },
  closingTitle: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: "clamp(2rem, 3.6vw, 2.75rem)",
    fontWeight: weight.semibold,
    lineHeight: 1.1,
    letterSpacing: "-0.035em",
  },
  closingLede: { margin: 0, marginTop: space.s4, marginBottom: space.s8, fontSize: text.lg, color: ink.body },

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
function JoinWithCode({ onIntent }: { onIntent: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!MEETING_CODE_REGEX.test(code)) {
            setError(`Enter a code like ${EXAMPLE_MEETING_CODE}, or paste the meeting’s link.`);
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
            setError("");
            setCode(readCodeInput(event.target.value));
          }}
          onFocus={onIntent}
          placeholder="Code or link"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "landing-code-error" : undefined}
          {...stylex.props(styles.joinInput)}
        />
        <button type="submit" {...stylex.props(styles.joinButton, motion.tint, focus.ring)}>
          Join
        </button>
      </form>
      {error ? (
        <p role="alert" id="landing-code-error" {...stylex.props(styles.error)}>
          {error}
        </p>
      ) : null}
    </>
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
  const firstName = session?.user?.name?.trim().split(/\s+/)[0] || "there";
  const queryClient = useQueryClient();
  const [createErrorMessage, setCreateErrorMessage] = useState("");
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
      setCreateErrorMessage(getCreateErrorMessage(error));
    },
  });

  const { mutate: createMeetingMutate, isPending: createPending } = createMutation;

  const handleCreateMeeting = useCallback(() => {
    if (!session?.user) return;
    setCreateErrorMessage("");
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
      return <span {...stylex.props(styles.start, styles.holding)}>Start a meeting</span>;
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
        Start a meeting
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
          <Link to="/pricing" {...stylex.props(touch.target, styles.headerLink, focus.ring, motion.tint)}>Pricing</Link>
          {sessionLoading ? null : signedIn ? (
            <Link to="/home" {...stylex.props(styles.openApp, focus.ring, motion.tint)}>Open app</Link>
          ) : (
            <Link to="/auth" search={{ mode: "login" }} {...stylex.props(touch.target, styles.headerLink, focus.ring, motion.tint)}>
              Sign in
            </Link>
          )}
        </header>
      </div>

      <main id={MAIN_CONTENT_ID}>
        {signedIn ? (
          <section aria-labelledby="hero-title" {...stylex.props(styles.wrap, styles.home)}>
            <div {...stylex.props(styles.homeWords)}>
              <div>
                <h1 id="hero-title" {...stylex.props(styles.greeting)}>Welcome back, {firstName}.</h1>
                <p {...stylex.props(styles.greetingLede)}>Start a call, or pick up where you left off.</p>
                <div {...stylex.props(styles.actions, styles.actionsStart, styles.homeActions)}>
                  {startMeeting()}
                  <JoinWithCode onIntent={handleMeetingIntent} />
                </div>
                {createErrorMessage ? (
                  <p role="alert" {...stylex.props(styles.error)}>{createErrorMessage}</p>
                ) : null}
              </div>
              <JumpBackIn />
            </div>
            <LatestMeeting viewerName={session?.user?.name ?? ""} />
          </section>
        ) : (
          <section aria-labelledby="hero-title" {...stylex.props(styles.wrap, styles.hero)}>
            <h1 id="hero-title" {...stylex.props(styles.headline)}>Video calls with a whiteboard everyone can use.</h1>
            <p {...stylex.props(styles.lede)}>Send a link, open the board, and work it out together.</p>
            <div {...stylex.props(styles.actions)}>
              {startMeeting()}
              <JoinWithCode onIntent={handleMeetingIntent} />
            </div>
            {createErrorMessage ? (
              <p role="alert" {...stylex.props(styles.error)}>{createErrorMessage}</p>
            ) : null}
            <p {...stylex.props(styles.fine)}>Free for small groups · Nothing to install · Guests don’t need an account</p>
          </section>
        )}

        {/*
          The tour is the prerendered page, so it stays up while the session
          resolves and goes only once we know the visitor is signed in.
        */}
        {signedIn ? null : (
          <>
            <LandingRoomShot />
            <LandingTour />
            <section aria-labelledby="closing-title" {...stylex.props(styles.wrap, styles.closing)}>
              <h2 id="closing-title" {...stylex.props(styles.closingTitle)}>Your next call starts here.</h2>
              <p {...stylex.props(styles.closingLede)}>Free for small groups. Open source.</p>
              {startMeeting()}
            </section>
          </>
        )}
      </main>

      <LandingFooter />
    </div>
  );
}

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
import { myLastReusableMeetingQueryOptions } from "@/app/query-client/queries/meetings";
import { MAIN_CONTENT_ID, SkipLink } from "@/app/shell/skip-link";
import { BrandMark, Spinner } from "@orbmeet/ui/react";
import { focus, motion, pressable, touch } from "@orbmeet/ui/styles/atoms";
import { accent, border, danger, ink, neutral, surface, violet } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

const CREATE_ERROR_FALLBACK = "Failed to create meeting. Please try again.";
const GITHUB_URL = "https://github.com/orbmeet/orbmeet";

/** CC0, from StockSnap (stocksnap.io/photo/E5GUBD8MWN). */
const HERO_PHOTO = "/images/landing/person-at-laptop-960.webp";
const HERO_PHOTO_SRCSET = "/images/landing/person-at-laptop-640.webp 640w, /images/landing/person-at-laptop-960.webp 960w";

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

/** What Orb is for, in words a first-time visitor would use, each with a real exchange. */
const ORB_EXAMPLES: readonly {
  ask: string;
  answer: string;
  title: string;
  body: string;
  /** "Only you" where Orb's answer is private. */
  note?: string;
  undo?: boolean;
  isPrivate?: boolean;
}[] = [
  {
    ask: "draw our sign-up steps",
    answer: "Drew the sign-up steps on this page.",
    undo: true,
    title: "Hard to explain? Orb can draw it.",
    body: "Say what you need and it appears on the board for everyone.",
  },
  {
    ask: "does our trip budget add up?",
    answer: "Almost. Flights and hotel on the board come to 2,000, not 2,100.",
    title: "Not sure? Orb can check.",
    body: "It sees the board, so you can ask if something looks right.",
  },
  {
    ask: "catch me up",
    answer: "You agreed to launch on Friday, and Sam is writing the email.",
    note: "Only you can see this",
    isPrivate: true,
    title: "Stepped away? Orb fills you in.",
    body: "Get a quick private summary without interrupting anyone.",
  },
];

const FOOTER_LINKS = [
  { to: "/status", label: "Status" },
  { to: "/terms", label: "Terms" },
  { to: "/privacy", label: "Privacy" },
  { to: "/refund", label: "Refunds" },
] as const;

// ─── Styles ──────────────────────────────────────────────────────────────────

const revealAsk = stylex.keyframes({
  "0%, 3%": { opacity: 0, transform: "translateY(6px)" },
  "7%, 92%": { opacity: 1, transform: "none" },
  "98%, 100%": { opacity: 0, transform: "none" },
});

const revealAnswer = stylex.keyframes({
  "0%, 16%": { opacity: 0, transform: "translateY(6px)" },
  "20%, 92%": { opacity: 1, transform: "none" },
  "98%, 100%": { opacity: 0, transform: "none" },
});

/**
 * One light page, on one ground: a plain promise and a person, then what Orb
 * helps with. Light whatever the visitor's own setting; the app follows each
 * person's choice once they have one.
 */
const styles = stylex.create({
  page: {
    colorScheme: "light",
    display: "flex",
    minHeight: "100svh",
    flexDirection: "column",
    backgroundColor: accent.a50,
    color: ink.strong,
    fontFamily: fonts.sans,
  },
  wrap: {
    width: "100%",
    maxWidth: "74rem",
    marginInline: "auto",
    paddingInline: { default: space.s4, [bp.sm]: space.s10 },
    boxSizing: "border-box",
  },
  header: { display: "flex", alignItems: "center", gap: space.s6, minHeight: 80 },
  brand: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s2_5,
    marginInlineEnd: "auto",
    color: ink.strong,
    textDecorationLine: "none",
    fontFamily: fonts.heading,
    fontWeight: weight.bold,
    fontSize: "1.1875rem",
    letterSpacing: "-0.02em",
    borderRadius: 6,
  },
  headerLink: {
    fontSize: text.base,
    color: { default: ink.body, [env.hoverable]: { default: ink.body, ":hover": ink.strong } },
    textDecorationLine: "none",
    borderRadius: 6,
  },
  openApp: {
    display: "inline-flex",
    alignItems: "center",
    height: 44,
    paddingInline: space.s4,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: accent.a600,
    borderRadius: 12,
    fontSize: text.base,
    fontWeight: weight.semibold,
    color: accent.a700,
    textDecorationLine: "none",
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": accent.a100 } },
  },

  hero: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.lg]: "minmax(0, 1fr) minmax(0, 1.2fr)" },
    alignItems: "center",
    columnGap: space.s16,
    rowGap: space.s8,
    paddingTop: { default: space.s6, [bp.lg]: space.s10 },
    paddingBottom: { default: space.s12, [bp.lg]: space.s20 },
  },
  heroWords: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: space.s5 },
  headline: {
    margin: 0,
    fontFamily: fonts.heading,
    fontWeight: weight.bold,
    fontSize: "clamp(2.625rem, 4.6vw + 0.5rem, 4.125rem)",
    lineHeight: 1.06,
    letterSpacing: "-0.035em",
    textWrap: "balance",
  },
  lede: { margin: 0, maxWidth: "28em", fontSize: "1.3125rem", lineHeight: 1.42, color: ink.body, textWrap: "pretty" },
  start: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s2,
    height: 58,
    paddingInline: space.s8,
    borderWidth: 0,
    borderRadius: 14,
    cursor: "pointer",
    fontSize: "1.125rem",
    fontWeight: weight.semibold,
    color: ink.onAccent,
    textDecorationLine: "none",
    backgroundColor: { default: accent.a600, [env.hoverable]: { default: accent.a600, ":hover:not(:disabled)": accent.a700 } },
    opacity: { default: 1, ":disabled": 0.7 },
  },
  holding: { cursor: "progress", opacity: 0.6 },
  join: { display: "flex", alignItems: "center", gap: space.s2, margin: 0, color: ink.body, fontSize: text.base },
  joinInput: {
    width: "8.5rem",
    height: 44,
    padding: 0,
    borderWidth: 0,
    borderBottomWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n400, ":focus": accent.a600 },
    borderRadius: 0,
    outlineStyle: "none",
    fontFamily: "inherit",
    fontSize: text.base,
    color: ink.strong,
    backgroundColor: "transparent",
    "::placeholder": { color: neutral.n500 },
  },
  joinButton: {
    height: 44,
    paddingInline: space.s2,
    borderWidth: 0,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: text.base,
    fontWeight: weight.semibold,
    color: accent.a700,
    backgroundColor: "transparent",
    borderRadius: 6,
  },
  error: { margin: 0, fontSize: text.sm, color: danger.d600 },
  rejoin: {
    fontSize: text.base,
    fontWeight: weight.medium,
    color: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    textDecorationLine: "none",
    borderRadius: 6,
  },
  photo: { display: "block", width: "100%", height: "auto", aspectRatio: "3 / 2", objectFit: "cover", borderRadius: 24 },

  orbSection: { display: "flex", flexDirection: "column", gap: space.s8, paddingBottom: { default: space.s12, [bp.lg]: space.s16 } },
  orbHead: { display: "flex", flexDirection: "column", gap: space.s2, textAlign: "center" },
  orbTitle: {
    margin: 0,
    fontFamily: fonts.heading,
    fontWeight: weight.bold,
    fontSize: "clamp(2.125rem, 2.6vw + 0.75rem, 2.875rem)",
    lineHeight: 1.1,
    letterSpacing: "-0.03em",
  },
  orbLede: { margin: 0, fontSize: "1.1875rem", color: ink.body },
  examples: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.md]: "repeat(3, minmax(0, 1fr))" },
    gap: space.s5,
  },
  example: { display: "flex", flexDirection: "column", gap: space.s5, padding: space.s6, borderRadius: 22, backgroundColor: surface.raised },
  exchange: { display: "flex", flexDirection: "column", justifyContent: "center", gap: space.s3, minHeight: 200, fontSize: text.sm, lineHeight: 1.4 },
  ask: {
    alignSelf: "flex-end",
    maxWidth: "88%",
    paddingInline: space.s3,
    paddingBlock: space.s2,
    borderRadius: 16,
    borderEndEndRadius: 5,
    color: ink.onAccent,
    backgroundColor: accent.a600,
    animationName: { default: revealAsk, [env.reducedMotion]: "none" },
    animationDuration: "12s",
    animationTimingFunction: "ease",
    animationIterationCount: "infinite",
  },
  askPrivate: { backgroundColor: neutral.n800 },
  orbToken: { fontWeight: weight.semibold, color: violet.v100 },
  answer: {
    display: "grid",
    gridTemplateColumns: "24px minmax(0, 1fr)",
    columnGap: space.s2_5,
    animationName: { default: revealAnswer, [env.reducedMotion]: "none" },
    animationDuration: "12s",
    animationTimingFunction: "ease",
    animationIterationCount: "infinite",
  },
  answerBody: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: space.s1_5 },
  orbName: { fontSize: "0.8125rem", fontWeight: weight.semibold, color: violet.v700 },
  orbNote: { fontWeight: weight.normal, color: ink.muted },
  reply: {
    paddingInline: space.s3,
    paddingBlock: space.s2,
    borderRadius: 14,
    borderStartStartRadius: 5,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: violet.v100,
    backgroundColor: accent.a50,
  },
  undo: {
    display: "inline-flex",
    alignItems: "center",
    height: 28,
    paddingInline: space.s2_5,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n150,
    fontSize: "0.8125rem",
    fontWeight: weight.semibold,
  },
  exampleTitle: { margin: 0, marginBottom: space.s1, fontSize: "1.4375rem", lineHeight: 1.2, fontWeight: weight.semibold, letterSpacing: "-0.015em" },
  exampleBody: { margin: 0, fontSize: text.base, lineHeight: 1.5, color: ink.body },

  footer: { marginTop: "auto", borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: border.subtle },
  footerRow: { display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: space.s5, paddingBlock: space.s2, fontSize: "0.9375rem", color: ink.muted },
  footerLinks: { display: "flex", flexWrap: "wrap", columnGap: space.s4, marginInlineStart: "auto" },
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
        <label htmlFor="landing-code">Have a code?</label>
        <input
          id="landing-code"
          value={code}
          onChange={(event) => {
            setError("");
            setCode(readCodeInput(event.target.value));
          }}
          onFocus={onIntent}
          placeholder="Enter it here"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
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

function OrbExample({ example }: { example: (typeof ORB_EXAMPLES)[number] }) {
  return (
    <li {...stylex.props(styles.example)}>
      <div aria-hidden="true" {...stylex.props(styles.exchange)}>
        <div {...stylex.props(styles.ask, example.isPrivate && styles.askPrivate)}>
          <span {...stylex.props(styles.orbToken)}>@Orb</span> {example.ask}
        </div>
        <div {...stylex.props(styles.answer)}>
          <BrandMark size={22} />
          <div {...stylex.props(styles.answerBody)}>
            <span {...stylex.props(styles.orbName)}>
              Orb{example.note ? <span {...stylex.props(styles.orbNote)}> · {example.note}</span> : null}
            </span>
            <span {...stylex.props(styles.reply)}>{example.answer}</span>
            {example.undo ? <span {...stylex.props(styles.undo)}>Undo</span> : null}
          </div>
        </div>
      </div>
      <div>
        <h3 {...stylex.props(styles.exampleTitle)}>{example.title}</h3>
        <p {...stylex.props(styles.exampleBody)}>{example.body}</p>
      </div>
    </li>
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
  // Returning users get a shortcut back to the permanent meeting link they last used.
  // Held until the session resolves so a logged-out visitor never fires an
  // authenticated (and therefore failing) request.
  const { data: lastReusable } = useQuery({
    ...myLastReusableMeetingQueryOptions(),
    enabled: !!session?.user,
  });
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
    if (session?.user) {
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
            <BrandMark size={26} />
            Orb Meet
          </Link>
          <Link to="/pricing" {...stylex.props(touch.target, styles.headerLink, focus.ring, motion.tint)}>Pricing</Link>
          {sessionLoading ? null : session?.user ? (
            <Link to="/home" {...stylex.props(styles.openApp, focus.ring, motion.tint)}>Open app</Link>
          ) : (
            <Link to="/auth" search={{ mode: "login" }} {...stylex.props(styles.openApp, focus.ring, motion.tint)}>Sign in</Link>
          )}
        </header>
      </div>

      <main id={MAIN_CONTENT_ID} {...stylex.props(styles.wrap)}>
        <section aria-labelledby="hero-title" {...stylex.props(styles.hero)}>
          <div {...stylex.props(styles.heroWords)}>
            <h1 id="hero-title" {...stylex.props(styles.headline)}>Video calls that stay useful after you hang up.</h1>
            <p {...stylex.props(styles.lede)}>
              Talk, sketch your ideas together, and let Orb lend a hand. Free for small teams, right in your browser.
            </p>
            {startMeeting()}
            {createErrorMessage ? (
              <p role="alert" {...stylex.props(styles.error)}>{createErrorMessage}</p>
            ) : null}
            <JoinWithCode onIntent={handleMeetingIntent} />
            {lastReusable ? (
              <a href={`/${lastReusable.code}`} {...stylex.props(touch.target, styles.rejoin, focus.ring, motion.tint)}>
                {`Rejoin ${
                  lastReusable.spaceKind === "shared"
                    ? (lastReusable.spaceName ?? lastReusable.linkTitle ?? "your space")
                    : (lastReusable.linkTitle ?? "your meeting")
                }`}
                {lastReusable.hasOpenMeeting && lastReusable.liveParticipantCount > 0
                  ? ` · ${lastReusable.liveParticipantCount} in it now`
                  : ""}{" "}
                →
              </a>
            ) : null}
          </div>
          <img
            src={HERO_PHOTO}
            srcSet={HERO_PHOTO_SRCSET}
            sizes="(min-width: 1024px) 40rem, 100vw"
            alt="A woman in glasses smiling at her laptop in a bright studio"
            width={960}
            height={640}
            fetchPriority="high"
            {...stylex.props(styles.photo)}
          />
        </section>

        <section aria-labelledby="orb-title" {...stylex.props(styles.orbSection)}>
          <div {...stylex.props(styles.orbHead)}>
            <h2 id="orb-title" {...stylex.props(styles.orbTitle)}>Orb is your helper on every call.</h2>
            <p {...stylex.props(styles.orbLede)}>Just type @Orb in the chat.</p>
          </div>
          <ul {...stylex.props(styles.examples)}>
            {ORB_EXAMPLES.map((example) => (
              <OrbExample key={example.title} example={example} />
            ))}
          </ul>
        </section>
      </main>

      <LandingFooter />
    </div>
  );
}

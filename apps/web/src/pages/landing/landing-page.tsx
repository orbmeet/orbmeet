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
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { MAIN_CONTENT_ID, SkipLink } from "@/app/shell/skip-link";
import { Spinner } from "@orbmeet/ui/react";
import { enter, stagger } from "@orbmeet/ui/styles/animations";
import { focus, motion, pressable, touch } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

const CREATE_ERROR_FALLBACK = "Failed to create meeting. Please try again.";
const INSTALL_COMMAND = "npm i -g @orbmeet/cli";
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

/**
 * The pictures, rendered in Blender at a few widths by
 * `scripts/landing-images/build.sh`: the hero's water, and three views of one
 * room, so the pictures below share the same light on the same table.
 */
const IMAGE_ROOT = "/images/landing";

function srcSet(name: string, widths: readonly number[]): string {
  return widths.map((width) => `${IMAGE_ROOT}/${name}-${width}.webp ${width}w`).join(", ");
}

/** What a meeting leaves you with, a photograph and a line each. */
const KEPT: readonly { image: string; alt: string; title: string; body: string }[] = [
  {
    image: "board",
    alt: "A board leaning on a sunlit wall, with a sign-up flow drawn on it twice, the second time in violet",
    title: "The board stays",
    body: "Named after the meeting it was drawn in, ready to pick up next time.",
  },
  {
    image: "recap",
    alt: "Two pages of notes and a pencil on an oak table, in a shaft of sunlight",
    title: "The recap writes itself",
    body: "A summary, the moments worth going back to, and who agreed to do what.",
  },
  {
    image: "orb",
    alt: "The violet orb on the oak table, catching the window",
    title: "Orb is in the room",
    body: "Ask it to check a step or draw on the board. Every word it hears is kept, and searchable.",
  },
];

// ─── Styles ──────────────────────────────────────────────────────────────────

/** Small capitals, tracked wide: the page's one typographic signature. */
const CAPS = { textTransform: "uppercase", letterSpacing: "0.18em" } as const;

/**
 * Black on white, centred, with type and space doing the work: small tracked
 * capitals for every label, one heavy headline, one black pill, and a dark
 * footer that carries the name. No boxes, drawings or glow. Light whatever the
 * visitor's own setting; the app follows each person's choice once they have one.
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
  },
  wrap: {
    width: "100%",
    maxWidth: "72rem",
    marginInline: "auto",
    paddingInline: { default: space.s5, [bp.sm]: space.s10 },
    boxSizing: "border-box",
  },

  header: { display: "flex", alignItems: "center", gap: space.s7, height: 88 },
  wordmark: {
    ...CAPS,
    letterSpacing: "0.08em",
    marginInlineEnd: "auto",
    color: ink.strong,
    textDecorationLine: "none",
    fontFamily: fonts.heading,
    fontWeight: 750,
    fontSize: "1rem",
    borderRadius: 4,
  },
  headerLink: {
    ...CAPS,
    fontSize: "0.75rem",
    color: { default: ink.muted, [env.hoverable]: { default: ink.muted, ":hover": ink.strong } },
    textDecorationLine: "none",
    borderRadius: 4,
  },
  headerLinkStrong: { color: ink.strong, fontWeight: weight.semibold },
  wide: { display: { default: "none", [bp.sm]: "inline" } },

  /**
   * The water, edge to edge, with the words on it. It is dark, so the hero
   * takes the dark side of every token: white type, a white pill.
   */
  hero: {
    colorScheme: "dark",
    color: ink.strong,
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s6,
    justifyContent: "center",
    minHeight: "clamp(560px, 86svh, 900px)",
    paddingInline: space.s5,
    paddingBlock: space.s12,
    boxSizing: "border-box",
    textAlign: "center",
    overflow: "hidden",
  },
  heroImage: {
    position: "absolute",
    inset: 0,
    zIndex: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    objectPosition: "50% 50%",
  },
  heroWords: { position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: space.s6 },
  // Balanced, so a wrap on a phone splits the line evenly instead of leaving one word under it.
  kicker: { ...CAPS, margin: 0, fontSize: "0.8125rem", fontWeight: weight.semibold, color: ink.strong, textWrap: "balance" },
  headline: {
    margin: 0,
    maxWidth: "15ch",
    fontFamily: fonts.heading,
    fontWeight: 750,
    fontSize: "clamp(2.75rem, 5.5vw + 0.5rem, 5.75rem)",
    lineHeight: 0.98,
    letterSpacing: "-0.035em",
  },
  actions: { display: "flex", flexDirection: "column", alignItems: "center", gap: space.s5, paddingTop: space.s3 },
  start: {
    ...CAPS,
    letterSpacing: "0.14em",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s2,
    height: 52,
    paddingInline: space.s9,
    borderWidth: 0,
    borderRadius: 999,
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: weight.bold,
    color: surface.raised,
    textDecorationLine: "none",
    backgroundColor: { default: ink.strong, [env.hoverable]: { default: ink.strong, ":hover:not(:disabled)": neutral.n800 } },
    opacity: { default: 1, ":disabled": 0.7 },
  },
  holding: { cursor: "progress", opacity: 0.6 },
  join: { display: "flex", alignItems: "center", gap: space.s2, margin: 0 },
  // Full strength: it sits on the water, where muted ink would sink.
  joinLabel: { ...CAPS, fontSize: "0.75rem", fontWeight: weight.semibold, color: ink.strong },
  // An underline to write on, not a box.
  joinInput: {
    width: "8.5rem",
    height: 36,
    paddingInline: 0,
    borderWidth: 0,
    borderBottomWidth: 1.5,
    borderStyle: "solid",
    borderColor: { default: ink.body, ":focus": ink.strong },
    borderRadius: 0,
    outlineStyle: "none",
    fontFamily: fonts.mono,
    fontSize: text.base,
    textAlign: "center",
    color: ink.strong,
    backgroundColor: "transparent",
    "::placeholder": { color: ink.body },
  },
  joinButton: {
    ...CAPS,
    height: 36,
    paddingInline: space.s2,
    borderWidth: 0,
    cursor: "pointer",
    fontSize: "0.75rem",
    fontWeight: weight.bold,
    color: { default: ink.strong, [env.hoverable]: { default: ink.strong, ":hover": accent.a700 } },
    backgroundColor: "transparent",
    borderRadius: 4,
  },
  error: { margin: 0, fontSize: text.sm, color: danger.d600 },
  aside: { margin: 0, fontSize: text.sm, color: ink.body },
  rejoin: {
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    textDecorationLine: "none",
    borderRadius: 4,
  },

  kept: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.md]: "repeat(3, minmax(0, 1fr))" },
    columnGap: space.s7,
    rowGap: space.s12,
    paddingBlock: { default: space.s12, [bp.md]: space.s20 },
    textAlign: "center",
  },
  keptItem: { display: "flex", flexDirection: "column", alignItems: "center", gap: space.s3 },
  keptImage: { display: "block", width: "100%", height: "auto", aspectRatio: "3 / 2", objectFit: "cover", marginBottom: space.s4 },
  keptTitle: { ...CAPS, margin: 0, fontSize: "0.8125rem", fontWeight: weight.bold },
  keptBody: { margin: 0, maxWidth: "30ch", fontSize: text.base, lineHeight: 1.6, color: ink.muted },

  /* ── Footer: the name, large, on black ── */
  footer: {
    colorScheme: "dark",
    marginTop: "auto",
    backgroundColor: surface.canvas,
    color: ink.strong,
    paddingBlock: { default: space.s12, [bp.md]: space.s16 },
  },
  footerGrid: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [bp.md]: "1.3fr 1fr 1fr" },
    gap: { default: space.s9, [bp.md]: space.s10 },
  },
  footerName: {
    ...CAPS,
    letterSpacing: "0.06em",
    margin: 0,
    fontFamily: fonts.heading,
    fontWeight: 750,
    fontSize: "1.875rem",
    lineHeight: 1.1,
  },
  // Under a finger each link is its own 44px row, which is spacing enough.
  footerColumn: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: { default: space.s2, [env.touch]: 0 } },
  footerHead: { ...CAPS, margin: 0, marginBottom: space.s2, fontSize: "0.75rem", fontWeight: weight.bold },
  footerText: { margin: 0, fontSize: text.sm, lineHeight: 1.6, color: ink.muted },
  footerLink: {
    fontSize: text.sm,
    color: { default: ink.muted, [env.hoverable]: { default: ink.muted, ":hover": ink.strong } },
    textDecorationLine: "none",
    borderRadius: 4,
  },
  install: {
    padding: 0,
    borderWidth: 0,
    cursor: "pointer",
    fontFamily: fonts.mono,
    fontSize: "0.8125rem",
    textAlign: "start",
    color: { default: ink.strong, [env.hoverable]: { default: ink.strong, ":hover": accent.a400 } },
    backgroundColor: "transparent",
    borderRadius: 4,
  },
  copied: { color: accent.a400 },
});

// ─── Pieces ──────────────────────────────────────────────────────────────────

/** The CLI's install command; a click puts it on the clipboard. */
function InstallCommand() {
  const { copied, copy } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => void copy(INSTALL_COMMAND)}
      // Naming the command is the point: an `aria-label` overrides the
      // contents, so it says what lands on the clipboard.
      aria-label={`Copy install command: ${INSTALL_COMMAND}`}
      {...stylex.props(touch.target, pressable.base, focus.ring, motion.tint, styles.install, copied && styles.copied)}
    >
      {copied ? "Copied" : INSTALL_COMMAND}
    </button>
  );
}

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
        <label htmlFor="landing-code" {...stylex.props(styles.joinLabel)}>or join</label>
        <input
          id="landing-code"
          value={code}
          onChange={(event) => {
            setError("");
            setCode(readCodeInput(event.target.value));
          }}
          onFocus={onIntent}
          placeholder={EXAMPLE_MEETING_CODE}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "landing-code-error" : undefined}
          {...stylex.props(styles.joinInput)}
        />
        <button type="submit" {...stylex.props(styles.joinButton, motion.tint, focus.ring)}>
          Join →
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

/** Where the footer points: the same five pages every public page ends with. */
const FOOTER_LINKS = [
  { to: "/pricing", label: "Pricing" },
  { to: "/status", label: "Status" },
  { to: "/terms", label: "Terms" },
  { to: "/privacy", label: "Privacy" },
  { to: "/refund", label: "Refunds" },
] as const;

function LandingFooter() {
  return (
    <footer {...stylex.props(styles.footer)}>
      <div {...stylex.props(styles.wrap, styles.footerGrid)}>
        <p {...stylex.props(styles.footerName)}>
          Orb
          <br />
          Meet
        </p>
        <div {...stylex.props(styles.footerColumn)}>
          <h2 {...stylex.props(styles.footerHead)}>Open source</h2>
          <p {...stylex.props(styles.footerText)}>MIT licensed. Run it yourself, or script it:</p>
          <InstallCommand />
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" {...stylex.props(touch.target, styles.footerLink, focus.ring, motion.tint)}>
            GitHub
          </a>
        </div>
        <nav aria-label="Site" {...stylex.props(styles.footerColumn)}>
          <h2 {...stylex.props(styles.footerHead)}>Orb Meet</h2>
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
          <Link to="/" {...stylex.props(touch.target, styles.wordmark, focus.ring)}>Orb Meet</Link>
          <Link to="/pricing" {...stylex.props(touch.target, styles.headerLink, focus.ring, motion.tint)}>Pricing</Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" {...stylex.props(touch.target, styles.headerLink, styles.wide, focus.ring, motion.tint)}>
            GitHub
          </a>
          {sessionLoading ? null : session?.user ? (
            <Link to="/home" {...stylex.props(touch.target, styles.headerLink, styles.headerLinkStrong, focus.ring, motion.tint)}>
              Open app
            </Link>
          ) : (
            <Link to="/auth" search={{ mode: "login" }} {...stylex.props(touch.target, styles.headerLink, styles.headerLinkStrong, focus.ring, motion.tint)}>
              Sign in
            </Link>
          )}
        </header>

      </div>

      <main id={MAIN_CONTENT_ID}>
        <section aria-labelledby="hero-title" {...stylex.props(styles.hero)}>
          <img
            src={`${IMAGE_ROOT}/hero-1600.webp`}
            srcSet={srcSet("hero", [1000, 1600, 2400])}
            sizes="100vw"
            alt=""
            fetchPriority="high"
            {...stylex.props(styles.heroImage)}
          />
          <div {...stylex.props(styles.heroWords)}>
            <p {...stylex.props(styles.kicker, enter.fadeUp)}>Video · one board · notes that write themselves</p>
            <h1 id="hero-title" {...stylex.props(styles.headline, enter.fadeUp, stagger.by(80))}>
              Meetings that keep what you worked out.
            </h1>
            <div {...stylex.props(styles.actions, enter.fadeUp, stagger.by(160))}>
              {startMeeting()}
              <JoinWithCode onIntent={handleMeetingIntent} />
            </div>
            {createErrorMessage ? (
              <p role="alert" {...stylex.props(styles.error)}>{createErrorMessage}</p>
            ) : null}
            {lastReusable ? (
              <a href={`/${lastReusable.code}`} {...stylex.props(touch.target, styles.rejoin, focus.ring, motion.tint)}>
                {`Rejoin ${
                  lastReusable.spaceKind === "shared"
                    ? (lastReusable.spaceName ?? lastReusable.linkTitle ?? "your space")
                    : (lastReusable.linkTitle ?? "your room")
                }`}
                {lastReusable.hasOpenMeeting && lastReusable.liveParticipantCount > 0
                  ? ` · ${lastReusable.liveParticipantCount} in it now`
                  : ""}{" "}
                →
              </a>
            ) : null}
            <p {...stylex.props(styles.aside)}>Free for small teams. Runs in your browser.</p>
          </div>
        </section>

        <div {...stylex.props(styles.wrap)}>
          <ul aria-label="What a meeting leaves you" {...stylex.props(styles.kept)}>
            {KEPT.map(({ image, alt, title, body }) => (
              <li key={title} {...stylex.props(styles.keptItem)}>
                <img
                  src={`${IMAGE_ROOT}/${image}-900.webp`}
                  srcSet={srcSet(image, [900, 1500])}
                  sizes="(min-width: 64rem) 30vw, 100vw"
                  alt={alt}
                  loading="lazy"
                  width={1500}
                  height={1000}
                  {...stylex.props(styles.keptImage)}
                />
                <h2 {...stylex.props(styles.keptTitle)}>{title}</h2>
                <p {...stylex.props(styles.keptBody)}>{body}</p>
              </li>
            ))}
          </ul>
        </div>
      </main>

      <LandingFooter />
    </div>
  );
}

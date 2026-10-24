import { BrandMark } from "@orbmeet/ui/react";
import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Link, Outlet, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useQueryClient, useQueryErrorResetBoundary } from "@tanstack/react-query";
import { logout } from "@/modules/identity/server/login.functions";
import { resetAuthQueryCache } from "@/modules/identity/client/auth-query-cache";
import { reportBoundaryError } from "@/lib/telemetry/client-errors";
import { Sidebar } from "@/app/shell/sidebar";
import { MobileNav } from "@/app/shell/mobile-nav";
import { UserMenu } from "@/app/shell/user-menu";
import { InstallOffer } from "@/app/shell/install-offer";
import { isCanvasPath } from "@/app/shell/canvas-path";
import { MAIN_CONTENT_ID, SkipLink } from "@/app/shell/skip-link";
import { applyAppearance, readAppearance } from "@/app/appearance/appearance";
import { ToastProvider } from "@orbmeet/ui/react";
import { useAuthenticatedSession } from "@/app/query-client/use-authenticated-session";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, border, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, safeArea, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

const routeApi = getRouteApi("/_authed");

const styles = stylex.create({
  errorGround: {
    display: "flex",
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.s8,
  },
  errorColumn: { textAlign: "center" },
  errorTitle: {
    margin: 0,
    fontSize: text.xl,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  errorDetail: {
    marginTop: space.s2,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  errorActions: {
    marginTop: space.s4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s3,
  },
  errorRetry: {
    borderRadius: radii.pill,
    backgroundColor: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    paddingInline: space.s4,
    paddingBlock: space.s2,
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: ink.onDark,
  },
  errorHome: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": neutral.n50 } },
    paddingInline: space.s4,
    paddingBlock: space.s2,
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: neutral.n700,
    textDecorationLine: "none",
  },

  shell: {
    display: "flex",
    minHeight: "100vh",
    backgroundColor: surface.canvas,
  },
  content: {
    position: "relative",
    display: "flex",
    minWidth: 0,
    flexGrow: 1,
    flexDirection: "column",
  },
  /** The phone header; the desktop rail carries the brand instead. */
  mobileHeader: {
    display: { default: "flex", [bp.lg]: "none" },
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: surface.raised,
    paddingInline: space.s4,
    paddingBlock: space.s3,
  },
  mobileBrand: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    textDecorationLine: "none",
  },
  mobileBrandName: {
    fontFamily: fonts.heading,
    fontSize: text.lg,
    fontWeight: weight.bold,
    letterSpacing: tracking.tight,
    color: ink.strong,
  },
  /**
   * Page content. On a desk it is a card beside the rail, inset from the
   * window like the rail is; on a phone it is the whole screen, and its bottom
   * padding clears the fixed tab bar plus the home-indicator inset.
   */
  main: {
    position: "relative",
    flexGrow: 1,
    backgroundColor: surface.raised,
    marginBlock: { default: 0, [bp.lg]: space.s3 },
    marginInlineEnd: { default: 0, [bp.lg]: space.s3 },
    borderWidth: { default: 0, [bp.lg]: 1 },
    borderStyle: "solid",
    borderColor: border.subtle,
    borderRadius: { default: 0, [bp.lg]: 20 },
    paddingInline: {
      default: space.s4,
      [bp.sm]: space.s6,
      [bp.lg]: space.s14,
    },
    paddingTop: { default: 0, [bp.lg]: space.s4 },
    paddingBottom: { default: `calc(${safeArea.bottom} + 6rem)`, [bp.lg]: space.s16 },
  },
  mainCanvas: {
    paddingInline: 0,
    paddingTop: 0,
    paddingBottom: 0,
    marginBlock: 0,
    marginInlineEnd: 0,
    borderWidth: 0,
    borderRadius: 0,
  },
});

export function AuthedErrorComponent({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const resetBoundary = useQueryErrorResetBoundary();

  useEffect(() => {
    resetBoundary.reset();
  }, [resetBoundary]);

  useEffect(() => {
    reportBoundaryError("authed", error);
  }, [error]);

  return (
    <div {...stylex.props(styles.errorGround)}>
      <div {...stylex.props(styles.errorColumn)}>
        <h2 {...stylex.props(styles.errorTitle)}>Something went wrong</h2>
        <p {...stylex.props(styles.errorDetail)}>
          We couldn&apos;t load this page. Please try again.
        </p>
        <div {...stylex.props(styles.errorActions)}>
          <button
            onClick={() => {
              resetBoundary.reset();
              reset();
              void router.invalidate();
            }}
            {...stylex.props(pressable.base, focus.ring, motion.tint, styles.errorRetry)}
          >
            Retry
          </button>
          <Link
            to="/home"
            {...stylex.props(pressable.base, focus.ring, motion.tint, styles.errorHome)}
          >
            Go Home
          </Link>
        </div>
      </div>
    </div>
  );
}

export function AuthedLayout() {
  return (
    <ToastProvider>
      <AuthedLayoutContent />
    </ToastProvider>
  );
}

function AuthedLayoutContent() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { session: initialSession } = routeApi.useRouteContext();
  const session = useAuthenticatedSession(initialSession);
  const router = useRouter();
  const queryClient = useQueryClient();
  const isLoggingOutRef = useRef(false);

  const handleLogout = async () => {
    if (isLoggingOutRef.current) return;
    isLoggingOutRef.current = true;
    try {
      await logout();
      // Same identity-change reset the login flow uses: cancel in-flight
      // fetches first so they cannot write the old user's data back into the
      // emptied cache (queryClient.clear() skips that cancellation).
      await resetAuthQueryCache(queryClient);
      // Leave the _authed branch before revalidating it. router.invalidate()
      // reloads every active match, so invalidating while still on /home re-runs
      // _authed.beforeLoad against the now-cleared session — the gate throws
      // redirect({ to: "/auth" }) and the user visibly bounces through the login
      // screen on their way out. Navigating first unmounts those matches, and
      // the invalidate afterwards drops their stale loader data.
      await router.navigate({ to: "/" });
      await router.invalidate();
    } catch (error) {
      console.error("Logout navigation failed:", error);
      window.location.href = "/";
    } finally {
      isLoggingOutRef.current = false;
    }
  };

  // The account's appearance follows the person: a choice made on another
  // device is taken up here, and this device remembers it for its next first
  // paint.
  const appearance = session.user.appearance;
  useEffect(() => {
    if (readAppearance() !== appearance) applyAppearance(appearance);
  }, [appearance]);

  // ⌘K (Ctrl+K elsewhere) is "find or join": the Library's search box, from
  // any page. A canvas page keeps the keys for the board.
  const navigate = useNavigate();
  const onCanvasPage = isCanvasPath(pathname);
  useEffect(() => {
    if (onCanvasPage) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      void navigate({ to: "/library", search: { find: true } });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, onCanvasPage]);

  // A canvas page is all canvas: no offer competes with the board for room.
  const onCanvas = onCanvasPage;

  const user = {
    name: session.user.name,
    email: session.user.email,
    image: session.user.image,
  };

  return (
    <div {...stylex.props(styles.shell)}>
      {/* Past the rail's brand, search, nav and Spaces, to the page itself. */}
      <SkipLink />
      <Sidebar
        user={user}
        onLogout={() => {
          void handleLogout();
        }}
        offer={onCanvas ? null : <InstallOffer variant="card" />}
        besideCanvas={onCanvas}
      />

      <div {...stylex.props(styles.content, layout.minZero)}>
        {/* Mobile header. A canvas page has its own header with a back
            button, so the shell's would only take rows from the board. */}
        {onCanvas ? null : (
          <div {...stylex.props(styles.mobileHeader)}>
            <Link to="/" {...stylex.props(styles.mobileBrand)}>
              <BrandMark size={28} />
              <span {...stylex.props(styles.mobileBrandName)}>
                Orb Meet
              </span>
            </Link>
            <UserMenu user={user} onLogout={() => void handleLogout()} />
          </div>
        )}

        <main id={MAIN_CONTENT_ID} {...stylex.props(styles.main, onCanvas && styles.mainCanvas)}>
          {onCanvas ? null : <InstallOffer variant="strip" />}
          <div {...stylex.props(enter.fade)}>
            <Outlet />
          </div>
        </main>
      </div>

      {onCanvas ? null : (
        <MobileNav />
      )}
    </div>
  );
}

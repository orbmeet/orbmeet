import { getRouteApi } from "@tanstack/react-router";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { RoomAudioRenderer } from "@livekit/components-react";

import { LiveMeeting } from "@/pages/meeting/live-meeting";
import { useDocumentTitle } from "@/app/shell/use-document-title";
import { MeetingConnection } from "@/modules/meetings/client/components/meeting-connection";
import { AudioPlaybackBlockedBanner } from "@/modules/meetings/client/components/audio-playback-blocked-banner";
import { PreJoinScreen, stopWarmupAudio } from "@/modules/meetings/client/components/pre-join-screen";
import { MeetingStatusScreen } from "@/modules/meetings/client/components/meeting-status-screen";
import { selectJoinErrorPresentation } from "@/modules/meetings/client/join-error-presentation";
import { markMeetingEntryMetric } from "@/modules/meetings/client/entry-metrics";
import { emitMeetingEntryDiagnostic } from "@/modules/meetings/client/entry/diagnostics";
import {
  MEETING_ROOM_CONNECT_OPTIONS,
  buildMeetingRoomOptions,
  reportMeetingMediaDeviceFailure,
  useMeetingEntry,
} from "@/modules/meetings/client/use-meeting-entry";
import { clearReconnectAdmissionId, loadReconnectAdmissionId } from "@/modules/meetings/client/reconnect-storage";
import { meetingHistoryPath } from "@/modules/meetings/client/urls";
import { sessionQueryOptions } from "@/app/query-client/queries/session";
import { SITE_NAME } from "@/lib/seo";
import { ToastProvider } from "@orbmeet/ui/react";
import { TooltipProvider } from "@orbmeet/ui/react";
import { ambient, progress, spinner, stagger } from "@orbmeet/ui/styles/animations";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { glow, surfaces } from "@orbmeet/ui/styles/surfaces";
import { accent, decor, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { preloadWhiteboard } from "@/modules/whiteboards/client/meeting/whiteboard-runtime";
import {
  ESSENTIAL_MEETING_UI,
  SECONDARY_MEETING_UI,
  preloadMeetingUi,
} from "@/modules/meetings/client/components/meeting-ui-modules";
import { logWarn } from "@/lib/logger";
import { glass } from "@orbmeet/ui/tokens/wash.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";

const routeApi = getRouteApi("/$code");

/**
 * Load the meeting's own UI while the participant is at the door: the parts
 * the call opens with first, then the rest when the page is idle. A part that
 * fails here is loaded again when it renders.
 */
function scheduleMeetingUiPreload() {
  const report = (error: unknown) => logWarn("[meeting] Could not preload the meeting UI:", error);
  preloadMeetingUi(ESSENTIAL_MEETING_UI).catch(report);
  const preload = () => {
    Promise.all([preloadMeetingUi(SECONDARY_MEETING_UI), preloadWhiteboard()]).catch(report);
  };

  if ("requestIdleCallback" in window) {
    const idleId = window.requestIdleCallback(preload, { timeout: 3_000 });
    return () => window.cancelIdleCallback(idleId);
  }

  const timer = globalThis.setTimeout(preload, 1_500);
  return () => globalThis.clearTimeout(timer);
}

const styles = stylex.create({
  /**
   * The pre-join desk. A warm paper-grey specific to the join flow, kept
   * literal: it is the surface the pre-join screen was tuned against.
   */
  desk: {
    backgroundColor: decor.paper,
  },
  connecting: {
    position: "relative",
    display: "flex",
    height: "100dvh",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  /**
   * The one drifting bloom behind the connecting card.
   *
   * `opacity` restates the reduced-motion step `ambient.orb1` sets, because a
   * property's conditional variants merge as one unit: a flat value here takes
   * the whole set with it, and the orb — parked mid-drift with its animation
   * off — loses the compensating opacity that keeps it visible.
   */
  connectingOrb: {
    width: 600,
    height: 600,
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    opacity: { default: 0.5, [env.reducedMotion]: 0.55 },
  },
  connectingCard: {
    position: "relative",
    borderRadius: radii.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: glass.solid,
    paddingInline: space.s12,
    paddingBlock: space.s10,
    textAlign: "center",
    boxShadow: shadows.lift3,
  },
  connectingGlyph: {
    marginInline: "auto",
    marginBottom: space.s4,
    display: "flex",
    height: 48,
    width: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
    backgroundImage: `linear-gradient(to bottom right, ${accent.a50}, ${accent.a100})`,
    boxShadow: shadows.hairline,
  },
  connectingSpinner: { width: 24, height: 24, borderWidth: 2 },
  connectingMessage: {
    margin: 0,
    fontSize: text.base,
    fontWeight: weight.semibold,
    color: neutral.n700,
  },
  connectingDots: {
    marginTop: space.s3,
    display: "flex",
    justifyContent: "center",
    gap: space.s1_5,
  },
  connectingDot: {
    height: 6,
    width: 6,
    borderRadius: radii.pill,
    backgroundColor: accent.a400,
  },

  /** The pre-join screen paints its own ground; the route just frames it. */
  preJoinGround: {
    position: "relative",
    width: "100%",
  },

  endedGround: {
    display: "flex",
    height: "100dvh",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: surface.canvas,
    paddingInline: space.s4,
  },
  endedCard: {
    maxWidth: "28rem",
    paddingInline: space.s8,
    paddingBlock: space.s9,
    textAlign: "center",
  },
  endedTitle: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: text.xl,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  endedDetail: {
    marginTop: space.s2,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.xl,
    color: ink.muted,
  },
  endedAction: {
    marginTop: space.s5,
    display: "inline-flex",
    borderRadius: radii.control,
    backgroundColor: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    paddingInline: space.s4,
    paddingBlock: space.s2,
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: ink.onAccent,
    textDecorationLine: "none",
  },
});

function ConnectingCard({ message }: { message: string }) {
  return (
    <div {...stylex.props(styles.connecting, styles.desk)}>
      <div
        {...stylex.props(
          // The old `liquid-blob-teal` stylesheet class, restated: the shared
          // orb treatment with the same tint, blur, and 18s drift.
          glow.orb(`color-mix(in oklab, ${accent.a500} 18%, transparent)`, 80),
          ambient.orb1,
          styles.connectingOrb,
        )}
      />
      <div {...stylex.props(styles.connectingCard)}>
        <div {...stylex.props(styles.connectingGlyph)}>
          {/* The old `liquid-spinner-light` class, at 24px/2px instead of 36/2.5. */}
          <div {...stylex.props(spinner.ring, spinner.brand, styles.connectingSpinner)} />
        </div>
        <p {...stylex.props(styles.connectingMessage)}>{message}</p>
        <div {...stylex.props(styles.connectingDots)}>
          <div {...stylex.props(styles.connectingDot, progress.bounceDot, stagger.by(0))} />
          <div {...stylex.props(styles.connectingDot, progress.bounceDot, stagger.by(150))} />
          <div {...stylex.props(styles.connectingDot, progress.bounceDot, stagger.by(300))} />
        </div>
      </div>
    </div>
  );
}

export function MeetingRoute() {
  const { lookup } = routeApi.useLoaderData();
  const { data: sessionData } = useQuery(sessionQueryOptions());

  if ("ended" in lookup && lookup.ended) {
    if (sessionData?.user) return <EndedMeetingRedirect meetingId={lookup.meetingId} />;
    return <EndedMeetingNotice />;
  }

  return <LiveMeetingRoute />;
}

/**
 * The ended-meeting dead end for someone who is not signed in.
 *
 * Deliberately says nothing about the Meeting page: that is where the recording
 * and summary land, but a signed-out guest cannot open it, and promising them
 * something they cannot reach is worse than saying nothing.
 */
function EndedMeetingNotice() {
  useDocumentTitle(`Meeting ended — ${SITE_NAME}`);
  return (
    <div {...stylex.props(styles.endedGround)}>
      <div {...stylex.props(surfaces.card, styles.endedCard)}>
        <h1 {...stylex.props(styles.endedTitle)}>This meeting has ended</h1>
        <p {...stylex.props(styles.endedDetail)}>
          This join link has already been used. Ask the organizer for a new one.
        </p>
        <a
          href="/"
          {...stylex.props(pressable.base, focus.ring, motion.tint, styles.endedAction)}
        >
          Return home
        </a>
      </div>
    </div>
  );
}

function EndedMeetingRedirect({ meetingId }: { meetingId: string }) {
  const navigate = useNavigate();

  React.useEffect(() => {
    void navigate({
      to: "/meetings/$meetingId",
      params: { meetingId },
      replace: true,
    });
  }, [meetingId, navigate]);

  return <ConnectingCard message="Opening Meeting history..." />;
}

function LiveMeetingRoute() {
  const { code } = routeApi.useParams();
  const { lookup } = routeApi.useLoaderData();
  const navigate = useNavigate();

  const { data: sessionData } = useQuery(sessionQueryOptions());
  const sessionUser = sessionData?.user;
  const authenticatedUser = React.useMemo(
    () => sessionUser ? { name: sessionUser.name } : undefined,
    [sessionUser],
  );
  const isSignedIn = Boolean(sessionUser);
  const navigateHome = React.useCallback(() => {
    if (authenticatedUser) {
      void navigate({ to: "/home" });
    } else {
      void navigate({ to: "/" });
    }
  }, [authenticatedUser, navigate]);

  const { session, entry } = useMeetingEntry({
    code,
    authenticatedUserName: authenticatedUser?.name,
  });
  const { phase, access, link } = entry;

  // The route head is fixed at "Join Meeting" because one head covers the join
  // screen, the room and the ended state, so the tab has to be set here.
  //
  // All three states, not two: a tab left open when the host ends the meeting
  // used to keep claiming to be a join screen while the page said the meeting
  // had ended — the exact symptom `use-document-title.ts` exists to fix.
  const meetingEnded =
    phase === "ended" || (phase === "failed" && entry.failure?.code === "MEETING_ENDED");
  useDocumentTitle(
    meetingEnded
      ? `Meeting ended — ${SITE_NAME}`
      : link
        ? `${access?.meetingTitle || code} — ${SITE_NAME}`
        : `Join Meeting — ${SITE_NAME}`,
  );

  React.useEffect(() => {
    markMeetingEntryMetric("routeMountedAt", { code });
    emitMeetingEntryDiagnostic("route_mounted", { code });
    const cancelPreload = scheduleMeetingUiPreload();
    return () => {
      cancelPreload();
      stopWarmupAudio();
    };
  }, [code]);

  // The join screen's facts — is the meeting open, can you start it — come
  // from the route's loader, which ran when you first arrived. Coming back to
  // it later (a takeover handed back with "Bring it back here", a failed join, a
  // retry) showed what was true then: a host returning to a room with three
  // people in it read "Not started yet. Joining starts it." Re-read them on
  // every return to the join screen.
  const router = useRouter();
  const previousPhase = React.useRef(phase);
  React.useEffect(() => {
    const returned = phase === "prejoin" && previousPhase.current !== "prejoin";
    previousPhase.current = phase;
    if (returned) void router.invalidate();
  }, [phase, router]);

  // In the meeting on another tab or device: present under an admission that
  // is not this tab's. A reload resumes this tab's own admission while its old
  // connection is still live, and must not read as a second device. The tab's
  // admission lives in session storage, so it is read after hydration.
  const viewerAdmissions = ("viewerAdmissionsInMeeting" in lookup ? lookup.viewerAdmissionsInMeeting : []).join(" ");
  const [inMeetingElsewhere, setInMeetingElsewhere] = React.useState(false);
  React.useEffect(() => {
    const own = loadReconnectAdmissionId(code);
    setInMeetingElsewhere(viewerAdmissions.split(" ").some((admissionId) => admissionId && admissionId !== own));
  }, [code, viewerAdmissions]);

  React.useEffect(() => {
    if (phase !== "connected") return;
    document.body.classList.add("meet-route");
    return () => document.body.classList.remove("meet-route");
  }, [phase]);

  // The macOS microphone warmup deliberately survives the pre-join component
  // while LiveKit takes ownership of the device. A terminal join failure has
  // no LiveKit handoff, so release the capture while the route remains mounted.
  React.useEffect(() => {
    if (phase === "failed") stopWarmupAudio();
  }, [phase]);

  // The meeting ended around this participant: a member goes to the Meeting's
  // record, a guest to the handoff page their admission can open.
  const endedMeetingId = phase === "ended" ? access?.meetingId : undefined;
  const endedAdmissionId = phase === "ended" ? access?.admissionId : undefined;
  React.useEffect(() => {
    if (!endedMeetingId) return;
    if (isSignedIn) {
      clearReconnectAdmissionId(code);
      window.location.assign(meetingHistoryPath(endedMeetingId));
      return;
    }
    void navigate({
      to: "/handoff/$meetingId",
      params: { meetingId: endedMeetingId },
      search: { admissionId: endedAdmissionId },
    });
  }, [code, endedAdmissionId, endedMeetingId, isSignedIn, navigate]);

  // ── Phase rendering ────────────────────────────────────────────────────────

  if (phase === "prejoin" || phase === "joining") {
    return (
      <div {...stylex.props(styles.preJoinGround, styles.desk)}>
        <PreJoinScreen
          meetingCode={code}
          meetingTitle={lookup.title ?? undefined}
          spaceName={lookup.spaceName ?? null}
          hostName={lookup.ownerName ?? null}
          onJoin={(submission) => session.submitPreJoin(submission)}
          onWaitingSettingsChange={(submission) => session.updateLobbyChoices(submission)}
          waitingForHost={entry.lobby !== null}
          waitingReason={entry.lobby?.reason ?? null}
          waitingRequestId={entry.lobby?.requestId ?? null}
          noOpenMeeting={!lookup.hasOpenMeeting}
          alreadyInMeeting={inMeetingElsewhere}
          canStartMeeting={lookup.canStartMeeting ?? false}
          scheduledStartsAt={lookup.scheduledStartsAt ?? null}
          scheduledTimeZone={lookup.scheduledTimeZone ?? null}
          scheduledNotOpenYet={lookup.scheduledNotOpenYet ?? false}
          isJoining={phase === "joining"}
          user={authenticatedUser}
        />
      </div>
    );
  }

  if (phase === "failed") {
    const presentation = selectJoinErrorPresentation(entry.failure?.code, {
      message: entry.failure?.message,
      isSignedIn,
    });
    // A member whose meeting just ended is one tap from the record the copy
    // above promises them. A guest has no such page, and is offered the way out
    // instead of a link they cannot follow.
    const recordMeetingId = meetingEnded ? access?.meetingId : undefined;
    const settledAction =
      recordMeetingId && sessionUser
        ? {
            label: "Open Meeting page",
            onClick: () => {
              void navigate({
                to: "/meetings/$meetingId",
                params: { meetingId: recordMeetingId },
              });
            },
          }
        : {
            label: "Back home",
            onClick: () => {
              navigateHome();
            },
          };
    return (
      <MeetingStatusScreen
        kind={presentation.kind}
        title={presentation.title}
        detail={presentation.detail}
        meetingCode={code}
        primaryAction={
          presentation.canRetry
            ? {
                label: presentation.retryLabel,
                onClick: () => session.retry(),
              }
            : settledAction
        }
        secondaryAction={
          presentation.canRetry
            ? {
                label: "Back home",
                onClick: () => {
                  navigateHome();
                },
              }
            : undefined
        }
      />
    );
  }

  if (phase === "ended") {
    return <ConnectingCard message="Opening Meeting history..." />;
  }

  const intent = session.intent.get();
  if (!link || !access || !intent) {
    return (
      <ConnectingCard
        message={phase === "recovering" ? "Reconnecting to meeting..." : "Joining meeting..."}
      />
    );
  }

  return (
    <MeetingConnection
      key={link.id}
      serverUrl={link.serverUrl}
      token={link.token}
      connectOptions={MEETING_ROOM_CONNECT_OPTIONS}
      options={buildMeetingRoomOptions(intent, link.peer)}
      videoEnabled={intent.videoEnabled}
      videoDeviceId={intent.videoDeviceId}
      audioEnabled={intent.audioEnabled}
      audioDeviceId={intent.audioDeviceId}
      fallback={<ConnectingCard message="Joining meeting..." />}
      onConnected={() => session.linkConnected(link.id)}
      // The meeting is mounted on RTC connect, but the pre-join warmup audio
      // stream is only torn down once the initial mic/camera publish has
      // settled, so LiveKit owns the microphone before the warmup stops.
      onInitialMediaSettled={stopWarmupAudio}
      onDisconnected={(reason) => session.linkDisconnected(link.id, reason)}
      onError={(error) => session.linkError(link.id, error)}
      onMediaDeviceFailure={(failure, kind) => reportMeetingMediaDeviceFailure(code, failure, kind)}
    >
      <RoomAudioRenderer />
      <AudioPlaybackBlockedBanner />
      {/* The board keeps its pager and zoom along the bottom edge. */}
      <ToastProvider liftAboveBottomControls>
        <TooltipProvider>
          <LiveMeeting
            code={code}
            joinResult={access}
            entry={session}
            showConnectingOverlay={phase !== "connected"}
            isAuthenticated={isSignedIn}
          />
        </TooltipProvider>
      </ToastProvider>
    </MeetingConnection>
  );
}

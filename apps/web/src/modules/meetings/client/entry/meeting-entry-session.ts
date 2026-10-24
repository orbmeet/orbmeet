import { ConnectionError, ConnectionErrorReason, type DisconnectReason } from "livekit-client";
import type { JoinMeetingResult, JoinResult } from "@/modules/meetings/contract/types";
import type { PreJoinSubmission } from "@/modules/meetings/client/types";
import { nextBackoffDelay } from "./backoff";
import type { DiagnosticDetail } from "./diagnostic-contract";
import type { MeetingEntryDiagnosticEvent } from "./diagnostics";
import { getMeetingDisconnectDisposition } from "./disconnect";
import {
  classifyJoinError,
  classifyJoinResponse,
  isStaleReconnectRejection,
  type JoinOutcome,
  type MeetingWaitingReason,
} from "./join-outcome";
import {
  DEFAULT_CAPTION_LANGUAGE,
  LocalMediaIntentStore,
  intentFromPreJoin,
} from "./local-media-intent";

// ── Schedules ────────────────────────────────────────────────────────────────

const JOIN_RPC_TIMEOUT_MS = 25_000;

/** A join the user asked for: retried briefly on a passing failure, then shown. */
const JOIN_ATTEMPT_DELAYS_MS = [0, 1_000, 3_000, 7_000] as const;

/**
 * Runs once LiveKit's own reconnect gives up (MAX_MEETING_RECONNECT_ELAPSED_MS).
 * Each attempt names the node it lost; the Worker probes that node and moves
 * the Meeting at once if it does not answer. About 80 seconds in all, so a
 * client that is itself offline for a minute still recovers.
 */
export const AUTO_REJOIN_DELAYS_MS = [0, 1_500, 5_000, 10_000, 15_000, 20_000, 30_000] as const;

/**
 * After a forced removal the join endpoint is asked why: a full room answers
 * PLAN_LIMIT_REACHED, a revoked admission answers MEETING_ADMISSION_DENIED,
 * and a meeting moved to another media node simply admits again.
 */
const REMOVAL_RECHECK_DELAYS_MS = [0, 1_500, 5_000] as const;

/**
 * A second removal this soon after a recheck is final rather than rechecked
 * again, so a participant the server keeps removing ends on an error screen
 * instead of in a loop. Removals further apart — two media-node moves in one
 * long meeting — are each rechecked.
 */
const REMOVAL_RECHECK_COOLDOWN_MS = 60_000;

const LOBBY_POLL = { baseMs: 5_000, maxMs: 30_000 } as const;
const LOBBY_POLL_JITTER = 0.2;

const DISCONNECTED_MESSAGE = "Disconnected from meeting. Please rejoin.";
const REMOVED_MESSAGE = "You were removed from the meeting.";

// ── Public shape ─────────────────────────────────────────────────────────────

export type MeetingEntryPhase =
  | "prejoin"
  | "joining"
  | "connecting"
  | "connected"
  | "recovering"
  | "leaving"
  | "ended"
  | "failed";

/**
 * One LiveKit connection attempt. `MeetingConnection` is mounted per link and
 * keyed by `id`; its events carry the id back, so an event from a connection
 * the session has moved past is ignored by construction.
 */
export interface MeetingEntryLink {
  id: number;
  token: string;
  serverUrl: string;
  peer: "standard" | "compat";
}

export interface MeetingEntrySnapshot {
  phase: MeetingEntryPhase;
  /** Set while the participant waits in the lobby (phase `prejoin`). */
  lobby: { reason: MeetingWaitingReason; requestId: string | null } | null;
  /** Set in phase `failed`. `code` is the server's error code, when there was one. */
  failure: { message: string; code: string | null } | null;
  /** The most recent access the server issued; kept through recovery for continuity. */
  access: JoinResult | null;
  /** The connection to mount, or null when none should exist. */
  link: MeetingEntryLink | null;
}

export interface MeetingJoinRequest {
  /** Names this request: a retry of it gets the same connection back. */
  clientAttemptId: string;
  displayName: string;
  reconnectAdmissionId?: string;
  /**
   * Names a first join, one without an admission to reconnect to, across all
   * its requests: a retry whose earlier answer was lost gets the same
   * admission back instead of a second one.
   */
  firstJoinKey?: string;
  captionLanguage: string;
  unreachableMediaUrl?: string;
  /**
   * The connection a removal took, when asking why. The server refuses to
   * take the seat back if another tab or device took it over.
   */
  replacesConnectionId?: string;
  /**
   * The meeting a recovery or removal recheck is finding its way back into.
   * Once it is over the server answers MEETING_ENDED, never the link's next
   * meeting.
   */
  resumeMeetingId?: string;
}

export interface ReleasableAccess {
  meetingId: string;
  connectionId: string;
}

type Timer = unknown;

export interface MeetingEntryDeps {
  joinMeeting: (request: MeetingJoinRequest) => Promise<JoinMeetingResult>;
  /**
   * Give back a connection the client will never use. The server ends it only
   * if it never reached the room, so releasing can never end a meeting.
   */
  releaseAccess: (access: ReleasableAccess) => Promise<unknown>;
  admissionIds: {
    load: () => string | undefined;
    persist: (admissionId: string) => void;
    clear: () => void;
  };
  /** The name to join under before the server has named this participant. */
  defaultDisplayName: () => string;
  /** Why this browser cannot join, or null when it can. */
  unsupportedBrowserReason: () => string | null;
  now?: () => number;
  random?: () => number;
  newAttemptId?: () => string;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  diagnostic?: (event: MeetingEntryDiagnosticEvent, detail?: DiagnosticDetail) => void;
  metric?: (metric: "joinRequestedAt" | "joinCredentialsReadyAt" | "liveKitConnectedAt") => void;
  logError?: (message: string, error?: unknown) => void;
  logWarn?: (message: string, detail?: unknown) => void;
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * One continuous effort to get into the meeting: the user's click, a stay in
 * the lobby, a recovery from a lost connection, or the recheck after a
 * removal. Only the answer to the episode's latest request counts; any other
 * admitted answer is released, which ends that connection alone.
 */
interface Episode {
  id: number;
  kind: "join" | "lobby" | "recover" | "removal";
  /** Requests sent so far; indexes the schedule for the next one. */
  step: number;
  latestAttempt: number;
  /** Whether the latest request is still unanswered, as far as the episode has heard. */
  awaitingAnswer: boolean;
  /** When the next request is due, while one is scheduled. */
  nextStepAt: number | null;
  won: boolean;
  lobbyDelayMs: number;
  unreachableMediaUrl?: string;
  /** For a removal recheck: the connection the removal took. */
  replacesConnectionId?: string;
}

interface LinkState extends MeetingEntryLink {
  connected: boolean;
}

function scheduleFor(kind: Exclude<Episode["kind"], "lobby">): readonly number[] {
  switch (kind) {
    case "join": return JOIN_ATTEMPT_DELAYS_MS;
    case "recover": return AUTO_REJOIN_DELAYS_MS;
    case "removal": return REMOVAL_RECHECK_DELAYS_MS;
  }
}

/**
 * Owns one participant's way into a meeting, and back in after losing it.
 *
 * It decides every transition between the pre-join screen, the lobby, a
 * connecting room, a connected room, recovery, and the final states, from
 * three kinds of input: user commands, join responses, and LiveKit connection
 * events. React reads its snapshot; the session holds no React state and is
 * tested without it.
 */
export class MeetingEntrySession {
  readonly intent = new LocalMediaIntentStore();

  private readonly listeners = new Set<() => void>();
  private readonly timers = new Set<Timer>();
  private readonly released = new Set<string>();

  private phase: MeetingEntryPhase = "prejoin";
  private lobby: MeetingEntrySnapshot["lobby"] = null;
  private failure: MeetingEntrySnapshot["failure"] = null;
  private access: JoinResult | null = null;
  private link: LinkState | null = null;
  private snapshot: MeetingEntrySnapshot;

  private episode: Episode | null = null;
  private stepTimer: Timer | null = null;
  private episodeSeq = 0;
  private attemptSeq = 0;
  private linkSeq = 0;

  private submitLocked = false;
  private peer: MeetingEntryLink["peer"] = "standard";
  private compatTried = false;
  private displayName: string | null = null;
  private lastServerUrl: string | null = null;
  private lastRemovalRecheckAt: number | null = null;
  /** The first join under way, until the server names its admission. */
  private firstJoinKey: string | null = null;
  private active = true;

  constructor(private readonly deps: MeetingEntryDeps) {
    this.snapshot = this.buildSnapshot();
  }

  // ── React binding ─────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): MeetingEntrySnapshot => this.snapshot;

  /**
   * The page is showing this session again. A paused episode carries on where
   * it stood: a request that was unanswered is sent again in its place in the
   * schedule, and a wait for the next one runs out what it had left.
   */
  activate(): void {
    if (this.active) return;
    this.active = true;
    const episode = this.episode;
    if (!episode || episode.won) return;
    if (episode.awaitingAnswer) {
      episode.step -= 1;
      this.sendAttempt(episode);
    } else if (episode.nextStepAt !== null) {
      this.scheduleStep(episode, Math.max(0, episode.nextStepAt - this.now()));
    }
  }

  /**
   * The page stopped showing this session. Every timer stops and the episode
   * pauses; an admitted answer that lands meanwhile is released. Reversible,
   * because React may unmount and remount the same page.
   */
  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    for (const timer of this.timers) this.clearTimer(timer);
    this.stepTimer = null;
  }

  /**
   * The page is in view again after being hidden. A phone that froze it — a
   * backgrounded tab on Chrome for Android — let the media server drop the
   * connection, and the recovery that followed has been waiting out a backoff
   * meant for a network that is down. The person is back and looking: send
   * the next request now rather than at the end of the wait.
   */
  pageShown(): void {
    if (!this.active) return;
    const episode = this.episode;
    if (!episode || episode.won || episode.kind !== "recover") return;
    if (episode.awaitingAnswer || episode.nextStepAt === null) return;
    if (episode.nextStepAt <= this.now()) return;
    this.scheduleStep(episode, 0);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  submitPreJoin(submission: PreJoinSubmission): void {
    if (!this.active || this.submitLocked) return;
    const blockReason = this.deps.unsupportedBrowserReason();
    if (blockReason) {
      this.fail({ message: blockReason, code: null }, { releaseAccess: false });
      return;
    }
    this.submitLocked = true;
    this.intent.replace(intentFromPreJoin(submission));
    this.displayName = submission.displayName ?? null;
    this.peer = "standard";
    this.compatTried = false;
    this.lastRemovalRecheckAt = null;
    this.access = null;
    this.link = null;
    this.failure = null;
    this.lobby = null;
    this.deps.metric?.("joinRequestedAt");
    this.diagnostic("join_clicked");
    this.phase = "joining";
    this.startEpisode("join");
    this.changed();
  }

  /** The lobby's device and language choices changed while waiting to be admitted. */
  updateLobbyChoices(submission: PreJoinSubmission): void {
    if (this.phase !== "prejoin" || !this.lobby) return;
    this.intent.replace(intentFromPreJoin(submission));
  }

  /** Back to the pre-join screen after a failure, as if the page had just loaded. */
  retry(): void {
    if (!this.active) return;
    this.endEpisode();
    this.submitLocked = false;
    this.peer = "standard";
    this.compatTried = false;
    this.lastRemovalRecheckAt = null;
    this.access = null;
    this.link = null;
    this.failure = null;
    this.lobby = null;
    this.phase = "prejoin";
    this.changed();
  }

  /** The participant is leaving or ending the meeting; its disconnect is expected. */
  beginLeave(): void {
    if (this.phase === "ended" || this.phase === "failed" || this.phase === "leaving") return;
    this.endEpisode();
    this.phase = "leaving";
    this.changed();
  }

  /** The meeting ended while this participant was in it. */
  meetingEnded(): void {
    // A participant already leaving is on their way out; their own navigation wins.
    if (
      this.phase === "prejoin" ||
      this.phase === "joining" ||
      this.phase === "failed" ||
      this.phase === "leaving" ||
      this.phase === "ended"
    ) {
      return;
    }
    this.endEpisode();
    this.link = null;
    this.phase = "ended";
    this.changed();
  }

  /** Fields an in-meeting action changed on the current access. */
  accessUpdated(updates: Partial<JoinResult>): void {
    if (!this.access) return;
    this.access = { ...this.access, ...updates };
    this.changed();
  }

  // ── LiveKit connection events ─────────────────────────────────────────────

  linkConnected(linkId: number): void {
    const link = this.currentLink(linkId);
    if (!link) return;
    this.link = { ...link, connected: true };
    if (this.phase !== "connecting") {
      this.changed();
      return;
    }
    // A connected room ends the episode that produced it: the next loss
    // starts a fresh recovery with its full schedule.
    this.endEpisode();
    this.compatTried = false;
    this.deps.metric?.("liveKitConnectedAt");
    this.diagnostic("livekit_connected");
    this.phase = "connected";
    this.changed();
  }

  linkError(linkId: number, error: unknown): void {
    const link = this.currentLink(linkId);
    if (!link) return;
    const reason = error instanceof ConnectionError ? error.reason : null;
    // A cancelled connect is our own teardown (unmount or disconnect).
    if (reason === ConnectionErrorReason.Cancelled) return;

    // ServerUnreachable: the signal WebSocket never came up. Try once more
    // in compatibility peer-connection mode before treating it as lost.
    if (
      !link.connected &&
      !this.compatTried &&
      link.peer === "standard" &&
      reason === ConnectionErrorReason.ServerUnreachable
    ) {
      this.compatTried = true;
      this.peer = "compat";
      this.deps.logWarn?.(
        "[Meeting] Signal connect failed; retrying with compatibility peer-connection mode",
      );
      this.openLink();
      this.changed();
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    this.diagnostic("livekit_error", { message: message.slice(0, 200) });
    this.deps.logError?.("[Meeting] LiveKit room error:", error);
    // An established room reports its loss through the disconnect event.
    if (link.connected || this.phase !== "connecting") return;
    this.recoverFromLostLink();
  }

  linkDisconnected(linkId: number, reason: DisconnectReason | undefined): void {
    const link = this.currentLink(linkId);
    if (!link) return;
    if (this.phase !== "connected" && this.phase !== "connecting") return;

    const disposition = getMeetingDisconnectDisposition(reason, link.connected);
    switch (disposition.kind) {
      case "ignore":
        return;
      case "ended":
        this.meetingEnded();
        return;
      case "terminal":
        this.fail({ message: disposition.message, code: null }, { releaseAccess: false });
        return;
      case "removed": {
        const now = this.now();
        if (
          this.lastRemovalRecheckAt !== null &&
          now - this.lastRemovalRecheckAt < REMOVAL_RECHECK_COOLDOWN_MS
        ) {
          this.fail({ message: REMOVED_MESSAGE, code: null }, { releaseAccess: false });
          return;
        }
        this.lastRemovalRecheckAt = now;
        this.link = null;
        this.phase = "recovering";
        this.startEpisode("removal", 0, this.access?.connectionId);
        this.changed();
        return;
      }
      case "rejoin":
        this.link = null;
        this.phase = "recovering";
        this.startEpisode("recover");
        this.changed();
        return;
    }
  }

  // ── Episodes ──────────────────────────────────────────────────────────────

  private startEpisode(kind: Episode["kind"], carryStep = 0, replacesConnectionId?: string): void {
    this.endEpisode();
    const episode: Episode = {
      id: ++this.episodeSeq,
      kind,
      step: carryStep,
      latestAttempt: 0,
      awaitingAnswer: false,
      nextStepAt: null,
      won: false,
      lobbyDelayMs: LOBBY_POLL.baseMs,
      // Every rejoin names the node it lost, so the Worker can move the
      // meeting off a node that is down for everyone.
      unreachableMediaUrl:
        kind === "recover" ? (this.lastServerUrl ?? undefined) : undefined,
      replacesConnectionId,
    };
    this.episode = episode;
    if (kind === "lobby") {
      this.scheduleStep(episode, this.jitter(episode.lobbyDelayMs));
    } else {
      this.scheduleNextOrExhaust(episode);
    }
  }

  private endEpisode(): void {
    this.episode = null;
    if (this.stepTimer !== null) {
      this.clearTimer(this.stepTimer);
      this.stepTimer = null;
    }
  }

  /** Schedule the episode's next request, or fail when its schedule is spent. */
  private scheduleNextOrExhaust(episode: Episode, lastFailure?: JoinOutcome): void {
    if (episode.kind === "lobby") {
      episode.lobbyDelayMs = nextBackoffDelay(episode.lobbyDelayMs, false, LOBBY_POLL);
      this.scheduleStep(episode, this.jitter(episode.lobbyDelayMs));
      return;
    }
    const delay = scheduleFor(episode.kind)[episode.step];
    if (delay !== undefined) {
      this.scheduleStep(episode, delay);
      return;
    }
    const failure =
      episode.kind === "join" && lastFailure && lastFailure.kind !== "admitted" && lastFailure.kind !== "wait"
        ? { message: lastFailure.message, code: lastFailure.code }
        : { message: DISCONNECTED_MESSAGE, code: null };
    this.fail(failure, { releaseAccess: true });
  }

  private scheduleStep(episode: Episode, delayMs: number): void {
    if (this.stepTimer !== null) this.clearTimer(this.stepTimer);
    episode.nextStepAt = this.now() + delayMs;
    this.stepTimer = this.setTimer(() => {
      this.stepTimer = null;
      episode.nextStepAt = null;
      if (this.episode === episode) this.sendAttempt(episode);
    }, delayMs);
  }

  /** A link that never connected: continue the recovery it belongs to, or start one. */
  private recoverFromLostLink(): void {
    const episode = this.episode;
    this.link = null;
    this.phase = "recovering";
    if (episode && (episode.kind === "recover" || episode.kind === "removal")) {
      // A fresh episode id, so no answer to an earlier request can be adopted
      // in place of the one that just failed; the schedule carries on.
      this.startEpisode(episode.kind, episode.step, episode.replacesConnectionId);
    } else {
      this.startEpisode("recover");
    }
    this.changed();
  }

  // ── Requests ──────────────────────────────────────────────────────────────

  private sendAttempt(episode: Episode): void {
    const attemptId = ++this.attemptSeq;
    episode.step += 1;
    episode.latestAttempt = attemptId;
    episode.awaitingAnswer = true;

    const request = (reconnectAdmissionId: string | undefined) =>
      this.deps.joinMeeting({
        clientAttemptId: this.deps.newAttemptId?.() ?? crypto.randomUUID(),
        displayName: this.displayName ?? this.deps.defaultDisplayName(),
        reconnectAdmissionId,
        firstJoinKey: reconnectAdmissionId ? undefined : (this.firstJoinKey ??= crypto.randomUUID()),
        captionLanguage: this.intent.get()?.captionLanguage ?? DEFAULT_CAPTION_LANGUAGE,
        unreachableMediaUrl: episode.unreachableMediaUrl,
        replacesConnectionId: episode.replacesConnectionId,
        resumeMeetingId: episode.kind === "recover" || episode.kind === "removal"
          ? this.access?.meetingId
          : undefined,
      });

    const send = async (): Promise<JoinMeetingResult> => {
      const storedAdmissionId = this.deps.admissionIds.load();
      const response = await request(storedAdmissionId);
      // sessionStorage outlives the credential that proves ownership of a
      // stored admission id, and it survives reload. Drop a rejected one and
      // ask again as a first-time joiner; a meeting the user genuinely cannot
      // enter answers FORBIDDEN again from the fresh-admission path.
      if (!storedAdmissionId || !isStaleReconnectRejection(response)) return response;
      if (this.episode !== episode) return response;
      this.forgetAdmission();
      this.diagnostic("reconnect_admission_discarded");
      return request(undefined);
    };

    let settled = false;
    const timeout = this.setTimer(() => {
      if (settled) return;
      settled = true;
      this.diagnostic("join_rpc_timeout", { timeoutMs: JOIN_RPC_TIMEOUT_MS });
      this.onOutcome(episode, attemptId, {
        kind: "retry",
        code: null,
        message: "Could not join meeting. Please try again.",
      });
    }, JOIN_RPC_TIMEOUT_MS);

    send().then(
      (response) => {
        this.clearTimer(timeout);
        const late = settled;
        settled = true;
        this.onResponse(episode, attemptId, response, late);
      },
      (error: unknown) => {
        this.clearTimer(timeout);
        if (settled) return;
        settled = true;
        this.onOutcome(episode, attemptId, classifyJoinError(error));
      },
    );
  }

  /**
   * An answer from the server. An admitted answer may have seated the
   * participant durably whatever became of the request on this side, so it is
   * either adopted or released — never dropped. Only the latest request's
   * answer is adopted: an older one that arrives late names a connection the
   * client has already moved past.
   */
  private onResponse(
    episode: Episode,
    attemptId: number,
    response: JoinMeetingResult,
    late: boolean,
  ): void {
    const outcome = classifyJoinResponse(response);
    if (outcome.kind === "admitted") {
      if (this.active && this.episode === episode && !episode.won && episode.latestAttempt === attemptId) {
        this.adopt(episode, outcome.access);
      } else {
        this.release(outcome.access);
      }
      return;
    }
    // A joined response without usable credentials still holds a seat.
    if (response.state === "joined") this.release(response.result);
    // After a timeout the episode has already moved on from this request.
    if (late) return;
    this.onOutcome(episode, attemptId, outcome);
  }

  private onOutcome(episode: Episode, attemptId: number, outcome: JoinOutcome): void {
    if (!this.active || this.episode !== episode || episode.won) return;
    if (episode.latestAttempt !== attemptId) return;
    episode.awaitingAnswer = false;

    switch (outcome.kind) {
      case "admitted":
        this.adopt(episode, outcome.access);
        return;
      case "wait":
        this.enterLobby(episode, outcome.reason, outcome.admissionId);
        return;
      case "retry":
        if (outcome.code === "RATE_LIMITED") {
          this.deps.logWarn?.("[Meeting] Join rate limited; backing off");
        } else {
          this.deps.logError?.("[Meeting] Join attempt failed; retrying:", outcome);
        }
        this.scheduleNextOrExhaust(episode, outcome);
        return;
      case "final":
        // The meeting this participant was in ended while they were finding
        // their way back: that is its end, not a failed join.
        if (
          outcome.code === "MEETING_ENDED" &&
          (episode.kind === "recover" || episode.kind === "removal") &&
          this.access
        ) {
          this.meetingEnded();
          return;
        }
        if (outcome.code === "MEETING_ADMISSION_DENIED") {
          this.diagnostic("admission_denied");
          this.forgetAdmission();
        }
        this.deps.logError?.("[Meeting] Failed to join meeting:", outcome);
        this.fail({ message: outcome.message, code: outcome.code }, { releaseAccess: true });
        return;
    }
  }

  private enterLobby(
    episode: Episode,
    reason: MeetingWaitingReason,
    admissionId: string | null,
  ): void {
    if (reason === "approval" && admissionId) this.rememberAdmission(admissionId);
    // Each poll of the lobby comes back here; the wait is reported once.
    if (this.lobby?.reason !== reason) this.diagnostic("admission_pending", { reason });
    this.link = null;
    this.phase = "prejoin";
    this.lobby = { reason, requestId: admissionId };
    this.failure = null;
    if (episode.kind === "lobby") {
      episode.lobbyDelayMs = LOBBY_POLL.baseMs;
      this.scheduleStep(episode, this.jitter(episode.lobbyDelayMs));
    } else {
      this.startEpisode("lobby");
    }
    this.changed();
  }

  private adopt(episode: Episode, access: JoinResult): void {
    episode.won = true;
    if (this.stepTimer !== null) {
      this.clearTimer(this.stepTimer);
      this.stepTimer = null;
    }
    this.displayName = access.participantName;
    this.lastServerUrl = access.serverUrl;
    this.rememberAdmission(access.admissionId);
    this.deps.metric?.("joinCredentialsReadyAt");
    this.diagnostic("access_issued");
    this.access = access;
    this.lobby = null;
    this.failure = null;
    this.openLink();
    this.changed();
  }

  private openLink(): void {
    const access = this.access;
    if (!access) return;
    this.link = {
      id: ++this.linkSeq,
      token: access.token,
      serverUrl: access.serverUrl,
      peer: this.peer,
      connected: false,
    };
    this.phase = "connecting";
    this.diagnostic("livekit_connecting");
  }

  // ── Endings ───────────────────────────────────────────────────────────────

  /**
   * `releaseAccess`: the current access was issued for a connection that will
   * now never be used, so give its seat back. Not for a connection the server
   * or LiveKit has already ended.
   */
  private fail(
    failure: { message: string; code: string | null },
    { releaseAccess }: { releaseAccess: boolean },
  ): void {
    this.endEpisode();
    if (releaseAccess && this.access && !this.link?.connected) this.release(this.access);
    this.link = null;
    this.lobby = null;
    this.failure = failure;
    this.phase = "failed";
    this.changed();
  }

  private release(access: ReleasableAccess): void {
    if (this.released.has(access.connectionId)) return;
    this.released.add(access.connectionId);
    this.deps
      .releaseAccess({ meetingId: access.meetingId, connectionId: access.connectionId })
      .catch((error: unknown) => {
        this.deps.logWarn?.("[Meeting] Failed to release an unused meeting connection:", error);
      });
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  /** The server named the admission: later joins reconnect to it. */
  private rememberAdmission(admissionId: string): void {
    this.deps.admissionIds.persist(admissionId);
    this.firstJoinKey = null;
  }

  /** The admission is no longer this client's: the next join is a new first join. */
  private forgetAdmission(): void {
    this.deps.admissionIds.clear();
    this.firstJoinKey = null;
  }

  private currentLink(linkId: number): LinkState | null {
    return this.link && this.link.id === linkId ? this.link : null;
  }

  private diagnostic(event: MeetingEntryDiagnosticEvent, detail?: DiagnosticDetail): void {
    this.deps.diagnostic?.(event, detail);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private jitter(delayMs: number): number {
    const random = this.deps.random?.() ?? Math.random();
    const delta = delayMs * LOBBY_POLL_JITTER;
    return delayMs - delta + random * 2 * delta;
  }

  private setTimer(callback: () => void, delayMs: number): Timer {
    const timer = (this.deps.setTimer ?? ((cb, ms) => globalThis.setTimeout(cb, ms)))(() => {
      this.timers.delete(timer);
      if (this.active) callback();
    }, delayMs);
    this.timers.add(timer);
    return timer;
  }

  private clearTimer(timer: Timer): void {
    this.timers.delete(timer);
    (this.deps.clearTimer ?? ((t) => globalThis.clearTimeout(t as ReturnType<typeof setTimeout>)))(timer);
  }

  private buildSnapshot(): MeetingEntrySnapshot {
    const link = this.link;
    return {
      phase: this.phase,
      lobby: this.lobby,
      failure: this.failure,
      access: this.access,
      link: link
        ? { id: link.id, token: link.token, serverUrl: link.serverUrl, peer: link.peer }
        : null,
    };
  }

  private changed(): void {
    const next = this.buildSnapshot();
    const previous = this.snapshot;
    const linkSame =
      previous.link === next.link ||
      (previous.link !== null && next.link !== null && previous.link.id === next.link.id &&
        previous.link.token === next.link.token);
    if (
      previous.phase === next.phase &&
      previous.lobby === next.lobby &&
      previous.failure === next.failure &&
      previous.access === next.access &&
      linkSame
    ) {
      return;
    }
    this.snapshot = linkSame ? { ...next, link: previous.link } : next;
    for (const listener of this.listeners) listener();
  }
}

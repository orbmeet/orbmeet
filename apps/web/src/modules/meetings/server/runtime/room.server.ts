import { createDb, type Database } from "@orbmeet/db";
import { DEFAULT_SPEECH_LANGUAGE, normalizeSpeechLanguageTag } from "@orbmeet/caption-protocol";
import { Errors } from "@/lib/app-errors";
import { generateId } from "@/lib/ids";
import { logError } from "@/lib/logger";
import { getPlanLimits } from "@/modules/billing/contract/plan-limits";
import { liveKitMeetingRoomName } from "@/modules/meetings/contract/livekit-room";
import { verifyGuestSecret } from "@/platform/crypto/tokens.server";
import { mediaNodes, type MediaNode } from "@/platform/realtime/nodes";
import { createLiveKitAccess } from "../livekit-token.server";
import { choosePlacement } from "../room/media-placement.server";
import type {
  CoordinatorCommand,
  CoordinatorReply,
  CoordinatorRequest,
  JoinReply,
  JoinRequest,
  SubjectInput,
} from "./api";
import { spaceRoleFor } from "./client.server";
import { executeEffect, publishSources } from "./effects.server";
import {
  EFFECT_RETRY_BASE_MS,
  initialState,
  isOpen,
  upgradeState,
  type MeetingSnapshot,
  type MeetingState,
} from "./model";
import { nextWakeAt, plan } from "./plan";
import { projectMeetingChanges } from "./projection.server";
import type { Effect, Input, Reply, Subject } from "./protocol";
import { applyInputs } from "./step";

/**
 * While effects are running, the room wakes at least this often, so an
 * effect lost to an eviction is planned again rather than waiting on a timer.
 */
const EFFECT_WATCHDOG_MS = 30_000;

/** A meeting's kept state, and the state D1 last showed while D1 may lag it. */
export interface StoredMeeting {
  state: MeetingState;
  /**
   * Present only while D1 may not show `state` yet: the state D1 last showed
   * (null when D1 shows none of it). The next commit projects from it.
   */
  projectedFrom?: MeetingState | null;
}

/** Where a meeting's state lives between requests: its Durable Object's storage. */
export interface MeetingRoomStorage {
  load(): Promise<StoredMeeting | null>;
  /** Keep `state`, and `projectedFrom` until {@link projected} says D1 caught up. Atomic. */
  save(state: MeetingState, projectedFrom: MeetingState | null): Promise<void>;
  /** D1 shows the kept state. */
  projected(): Promise<void>;
  /** Forget the meeting: its storage and its alarm. */
  clear(): Promise<void>;
  setAlarm(at: number | null): Promise<void>;
}

export interface MeetingRoomOptions {
  now?: () => number;
}

/**
 * The single writer of one open meeting's live state.
 *
 * Every change runs one at a time: load the state, step it with the pure core
 * (./step.ts), keep the new state, then write the D1 rows that differ from
 * what D1 last showed. The state is kept first, together with what D1 last
 * showed, so D1 may lag the room but never lead it: a projection lost to a
 * failure or an eviction is redone by the next commit or the alarm. A reply
 * waits for the projection, so it never promises what D1 does not yet show.
 *
 * Effects are what `plan` derives from the kept state, plus the egress start
 * an input issued. They run once D1 shows the state that called for them,
 * after the reply; each result is the next input. `plan` is idempotent, so an
 * effect lost with the instance is planned again when the alarm next wakes
 * the room.
 */
export class MeetingRoomHost {
  private readonly db: Database;
  private readonly now: () => number;
  /** Undefined until loaded; null for a meeting with no state. */
  private state: MeetingState | null | undefined;
  /**
   * What D1 last showed while it may lag `state` (null: none of it);
   * undefined once D1 shows `state`.
   */
  private projectedFrom: MeetingState | null | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly running = new Map<string, Promise<void>>();
  /** The alarm this instance last set; undefined until it has set one. */
  private alarmAt: number | null | undefined;

  constructor(
    private readonly env: Env,
    private readonly meetingId: string,
    private readonly storage: MeetingRoomStorage,
    options: MeetingRoomOptions = {},
  ) {
    this.db = createDb(env.DB);
    this.now = options.now ?? Date.now;
  }

  async handle(request: CoordinatorRequest): Promise<CoordinatorReply> {
    switch (request.kind) {
      case "wake":
        await this.apply(() => [{ kind: "tick" }]);
        return { kind: "ok" };
      case "join":
        return this.join(request.join, request.deadline);
      case "command":
        return this.command(request.command, request.deadline);
      case "observe":
        await this.apply((state) =>
          // A meeting that moved no longer hears from the node it left.
          state.meta.nodeId === request.nodeId ? [request.observation] : []);
        return { kind: "ok" };
    }
  }

  /** The alarm: let time pass, then keep effects moving. */
  async alarm(): Promise<void> {
    // The runtime cleared the alarm that fired.
    this.alarmAt = undefined;
    try {
      await this.apply(() => [{ kind: "tick" }]);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "MEETING_ENDED" || code === "NOT_FOUND") return;
      logError("[meetings] Alarm failed", error);
      // Unless the failure already asked for a sooner retry.
      if (this.alarmAt == null) await this.setAlarm(this.now() + EFFECT_WATCHDOG_MS);
    }
  }

  /** Resolves once every effect started so far, and every result it led to, has settled. */
  async idle(): Promise<void> {
    // A settling commit may start the next effect, so both are re-checked
    // until neither has anything left.
    do {
      while (this.running.size > 0) await Promise.allSettled(this.running.values());
      await this.tail;
    } while (this.running.size > 0);
  }

  // ─── Requests ──────────────────────────────────────────────────────────────

  private async join(join: JoinRequest, deadline: number | undefined): Promise<JoinReply> {
    const newAdmissionId = generateId("MEETING_ADMISSION");
    const newAttemptId = generateId("MEETING_CONNECTION");
    const placed = await this.placementFor(join);

    const reply = await this.apply(async (state) => {
      const { subject, inputs } = await this.resolveSubject(state, join.subject, join.admissionId);
      if (placed) inputs.push(placed);
      inputs.push({
        kind: "join",
        subject,
        admissionId: join.admissionId,
        clientAttemptId: join.clientAttemptId,
        displayName: join.displayName,
        captionLanguage: normalizeSpeechLanguageTag(join.captionLanguage) ?? DEFAULT_SPEECH_LANGUAGE,
        replacesAttemptId: join.replacesAttemptId,
        newAdmissionId,
        newAttemptId,
        newGuestSecretHash: join.newGuestSecretHash,
        guestNetworkKey: join.subject.kind === "guest" ? join.guestNetworkKey : null,
      });
      return inputs;
    }, { deadline });

    if (reply?.kind === "waiting") return reply;
    if (reply?.kind !== "admitted") throw Errors.INTERNAL();
    const { participant } = reply;
    const node = mediaNodes(this.env).get(participant.nodeId);
    if (!node) throw Errors.MEDIA_UNAVAILABLE();
    return { ...await accessFor(node, participant), newGuestAdmission: reply.newGuestAdmission };
  }

  /**
   * Where the meeting should be for this join, decided outside the room's
   * queue: placement reads node health and load from D1 and may probe a node,
   * for up to seconds when the node is down, and nothing else the meeting
   * hears should wait on that. It is decided from the node the meeting was on
   * when it looked, and the `placed` input moves the meeting only if it is
   * still there when the join commits: a join that commits in between has
   * placed it already. A meeting with no state yet is where D1 has it, which
   * is where its first commit starts it.
   */
  private async placementFor(join: JoinRequest): Promise<Extract<Input, { kind: "placed" }> | null> {
    const seen = await this.peek((state) => (state === null ? null : { open: isOpen(state), nodeId: state.meta.nodeId }));
    if (seen && !seen.open) return null;
    const from = seen ? seen.nodeId : (await this.snapshot()).nodeId;
    const current = from ? mediaNodes(this.env).get(from) : undefined;
    if (current && join.unreachableMediaUrl !== current.url) return null;
    const node = await choosePlacement(this.db, this.env, from, join.unreachableMediaUrl, join.nodeLatencies);
    return { kind: "placed", nodeId: node.id, from };
  }

  private async command(command: CoordinatorCommand, deadline: number | undefined): Promise<CoordinatorReply> {
    const reply = await this.apply(async (state) => {
      if (command.kind === "refreshAuthority") {
        return [await this.readAuthority(state, command.userId, command.reason)];
      }
      if (!("subject" in command)) return [command];
      const attemptAdmission = "attemptId" in command && command.attemptId
        ? state.attempts[command.attemptId]?.admissionId ?? null
        : null;
      const { subject, inputs } = await this.resolveSubject(state, command.subject, attemptAdmission);
      return [...inputs, { ...command, subject }];
    }, { deadline });
    return reply ?? { kind: "ok" };
  }

  // ─── Commit ────────────────────────────────────────────────────────────────

  /**
   * Apply the inputs `build` returns as one change and resolve with the last
   * input's reply. When an input is refused, what the inputs before it did is
   * still kept, then the refusal is thrown. `release` names the running
   * effect whose result this is: its slot is freed once the result is kept,
   * so the effects this commit plans include its successor. A change whose
   * `deadline` passed while it waited its turn is refused unapplied.
   */
  private apply(
    build: (state: MeetingState) => Input[] | Promise<Input[]>,
    { release, deadline }: { release?: string; deadline?: number } = {},
  ): Promise<Reply | undefined> {
    const run = this.tail.then(() => {
      if (deadline !== undefined && this.now() > deadline) throw Errors.MEETING_BUSY();
      return this.commit(build, release);
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Look at the state as the commits queued before this have left it, changing nothing. */
  private peek<T>(look: (state: MeetingState | null) => T): Promise<T> {
    const run = this.tail.then(async () => look(await this.load()));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async commit(
    build: (state: MeetingState) => Input[] | Promise<Input[]>,
    release: string | undefined,
  ): Promise<Reply | undefined> {
    const before = await this.load();
    const base = before ?? initialState(await this.snapshot(), this.now());
    const inputs = await build(base);
    const now = this.now();
    const { state: draft, reply, once, refusal } = applyInputs(base, inputs, now);

    // A request that finds the room as it was keeps nothing.
    if (!before || JSON.stringify(before) !== JSON.stringify(draft)) {
      if (this.projectedFrom === undefined) this.projectedFrom = before;
      await this.storage.save(draft, this.projectedFrom);
      this.state = draft;
    }
    if (release) this.running.delete(release);
    await this.project(now);

    const state = this.state!;
    if (state.meta.phase === "drained") {
      await this.storage.clear();
      this.state = null;
      this.alarmAt = null;
    } else {
      this.start(state, once);
      await this.schedule(state, now);
    }
    if (refusal !== undefined) throw refusal;
    return reply;
  }

  /** Bring D1 up to the kept state. A failure is retried by the alarm, and the request fails. */
  private async project(now: number): Promise<void> {
    if (this.projectedFrom === undefined) return;
    const statements = projectMeetingChanges(this.db, this.projectedFrom, this.state!, now);
    try {
      if (statements.length > 0) await this.db.batch(statements as [typeof statements[number], ...typeof statements]);
    } catch (error) {
      await this.setAlarm(now + EFFECT_RETRY_BASE_MS);
      throw error;
    }
    this.projectedFrom = undefined;
    await this.storage.projected();
  }

  private async load(): Promise<MeetingState | null> {
    if (this.state === undefined) {
      const stored = await this.storage.load();
      this.state = stored?.state ? upgradeState(stored.state) : null;
      this.projectedFrom = stored?.projectedFrom ? upgradeState(stored.projectedFrom) : stored?.projectedFrom;
    }
    return this.state;
  }

  private async schedule(state: MeetingState, now: number): Promise<void> {
    let at = nextWakeAt(state, now);
    if (this.running.size > 0) at = Math.min(at ?? Infinity, now + EFFECT_WATCHDOG_MS);
    await this.setAlarm(at);
  }

  private async setAlarm(at: number | null): Promise<void> {
    if (at === this.alarmAt) return;
    await this.storage.setAlarm(at);
    this.alarmAt = at;
  }

  // ─── Effects ───────────────────────────────────────────────────────────────

  /**
   * Start what the state calls for and is not already running. A `once`
   * effect always starts: nothing plans it again, so waiting for an earlier
   * run of the same key would lose it.
   */
  private start(state: MeetingState, once: readonly Effect[]): void {
    for (const effect of once) this.run(`${effect.key}#${crypto.randomUUID()}`, effect, state);
    for (const effect of plan(state, this.now())) {
      if (!this.running.has(effect.key)) this.run(effect.key, effect, state);
    }
  }

  private run(slot: string, effect: Effect, state: MeetingState): void {
    const work: Promise<void> = this.settle(slot, effect, state).finally(() => {
      // A commit that failed before keeping the result left the slot held;
      // the effect is then planned again.
      if (this.running.get(slot) === work) this.running.delete(slot);
    });
    this.running.set(slot, work);
  }

  /** Run an effect and keep its result as the next input. */
  private async settle(slot: string, effect: Effect, state: MeetingState): Promise<void> {
    let result: Input;
    try {
      result = {
        kind: "effectSucceeded",
        key: effect.key,
        result: await executeEffect(effect, { env: this.env, db: this.db, state }),
      };
    } catch (error) {
      logError("[meetings] Effect failed", { effect: effect.key }, error);
      result = {
        kind: "effectFailed",
        key: effect.key,
        error: error instanceof Error ? error.message : String(error),
        ...("placement" in effect && { placement: effect.placement }),
      };
    }
    // The slot is held until the commit that keeps the result frees it:
    // freed earlier, another commit in between would find the effect neither
    // running nor done and start it again; freed later, that commit would not
    // start the effect's successor (a newer grant).
    await this.apply(() => [result], { release: slot }).catch((error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== "MEETING_ENDED" && code !== "NOT_FOUND") {
        logError("[meetings] Could not apply an effect's result", { effect: effect.key }, error);
      }
    });
  }

  // ─── Inputs ────────────────────────────────────────────────────────────────

  /** The meeting as D1 has it, for state created on first contact. */
  private async snapshot(): Promise<MeetingSnapshot> {
    const meeting = await this.db.query.meetings.findFirst({
      where: { id: this.meetingId },
      columns: {
        id: true,
        title: true,
        spaceId: true,
        spaceKind: true,
        allowGuests: true,
        startedByUserId: true,
        organizerUserId: true,
        startedAt: true,
        joinPolicy: true,
        recordingEnabled: true,
        transcriptionEnabled: true,
        billingPlan: true,
        status: true,
        mediaNodeId: true,
        firstJoinedAt: true,
      },
    });
    if (!meeting) throw Errors.NOT_FOUND("Meeting");
    if (meeting.status !== "open") throw Errors.MEETING_ENDED();
    const limits = getPlanLimits(meeting.billingPlan);
    return {
      meetingId: meeting.id,
      title: meeting.title,
      spaceId: meeting.spaceId,
      spaceKind: meeting.spaceKind,
      allowGuests: meeting.allowGuests,
      startedByUserId: meeting.startedByUserId,
      organizerUserId: meeting.organizerUserId,
      startedAt: meeting.startedAt.getTime(),
      joinPolicy: meeting.joinPolicy,
      maxParticipants: limits.maxParticipants,
      recordingEnabled: meeting.recordingEnabled && limits.recordingEnabled,
      transcription: meeting.transcriptionEnabled,
      maxDurationMs: limits.maxMeetingDurationMinutes === null ? null : limits.maxMeetingDurationMinutes * 60_000,
      nodeId: meeting.mediaNodeId,
      firstJoinedAt: meeting.firstJoinedAt?.getTime() ?? null,
    };
  }

  /**
   * Who is asking, and the inputs to apply before their request. A user's
   * current Space authority is read here, inside the commit, and applied as
   * its own input first, so a revocation it implies is kept even when the
   * request is then refused.
   */
  private async resolveSubject(
    state: MeetingState,
    input: SubjectInput,
    admissionId: string | null,
  ): Promise<{ subject: Subject; inputs: Input[] }> {
    switch (input.kind) {
      case "system":
        return { subject: input, inputs: [] };
      case "user": {
        const authority = await this.readAuthority(state, input.userId, "space_membership_removed");
        return { subject: { kind: "user", userId: input.userId, spaceRole: authority.spaceRole }, inputs: [authority] };
      }
      case "guest": {
        const named = input.admissionId ?? admissionId;
        const admission = named ? state.admissions[named] : undefined;
        const verified = Boolean(
          admission?.guestSecretHash && input.secret && await verifyGuestSecret(admission.guestSecretHash, input.secret),
        );
        return { subject: { kind: "guest", admissionId: named, verified }, inputs: [] };
      }
    }
  }

  /**
   * Read a user's Space authority from D1. Commits run one at a time, so a
   * read made here is ordered with every other one this meeting applies;
   * `readAt` is taken on the room's own clock before the read starts.
   */
  private async readAuthority(
    state: MeetingState,
    userId: string,
    reason: string,
  ): Promise<Extract<Input, { kind: "authority" }>> {
    const readAt = this.now();
    const spaceRole = await spaceRoleFor(this.db, state.meta, userId);
    return { kind: "authority", userId, spaceRole, reason, readAt };
  }
}

async function accessFor(
  node: MediaNode,
  participant: Extract<Reply, { kind: "admitted" }>["participant"],
): Promise<Omit<Extract<JoinReply, { kind: "admitted" }>, "newGuestAdmission">> {
  const { token, expiresIn } = await createLiveKitAccess({
    apiKey: node.apiKey,
    apiSecret: node.apiSecret,
    identity: participant.identity,
    name: participant.displayName,
    roomName: liveKitMeetingRoomName(participant.meetingId),
    attributes: {
      ...participant.grant.attributes,
      "orbmeet.caption_language": participant.captionLanguage,
    },
    canPublishSources: publishSources(participant.grant),
  });
  return { kind: "admitted", participant, token, expiresIn, serverUrl: node.url };
}

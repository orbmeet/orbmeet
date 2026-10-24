import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionError, DisconnectReason } from "livekit-client";
import type { JoinMeetingResult, JoinResult } from "@/modules/meetings/contract/types";
import type { PreJoinSubmission } from "@/modules/meetings/client/types";
import {
  AUTO_REJOIN_DELAYS_MS,
  MeetingEntrySession,
  type MeetingJoinRequest,
} from "./meeting-entry-session";

// ── Harness ──────────────────────────────────────────────────────────────────

let generation = 0;

function access(overrides: Partial<JoinResult> = {}): JoinResult {
  generation += 1;
  return {
    token: `token-${generation}`,
    serverUrl: "wss://node-a.test",
    roomName: "room",
    meetingId: "meeting-1",
    meetingStartedAtMs: 0,
    serverNowMs: 0,
    connectionId: `connection-${generation}`,
    admissionId: "admission-1",
    participantName: "Ada",
    ...overrides,
  } as JoinResult;
}

const joined = (result: JoinResult = access()): JoinMeetingResult => ({ state: "joined", result });
const blocked = (code: string, retryable: boolean): JoinMeetingResult => ({
  state: "blocked",
  code,
  message: code,
  retryable,
});
const waitingForApproval = (admissionId = "admission-w"): JoinMeetingResult => ({
  state: "waiting",
  reason: "approval",
  message: "Waiting",
  admissionId,
  meetingId: "meeting-1",
});

interface PendingJoin {
  request: MeetingJoinRequest;
  resolve: (response: JoinMeetingResult) => void;
  reject: (error: unknown) => void;
}

function createHarness(options: { unsupported?: string } = {}) {
  const requests: PendingJoin[] = [];
  const releaseAccess = vi.fn(async () => undefined);
  let storedAdmissionId: string | undefined;
  const admissionIds = {
    load: vi.fn(() => storedAdmissionId),
    persist: vi.fn((id: string) => {
      storedAdmissionId = id;
    }),
    clear: vi.fn(() => {
      storedAdmissionId = undefined;
    }),
  };
  const diagnostic = vi.fn();
  const session = new MeetingEntrySession({
    joinMeeting: (request) =>
      new Promise<JoinMeetingResult>((resolve, reject) => {
        requests.push({ request, resolve, reject });
      }),
    releaseAccess,
    admissionIds,
    defaultDisplayName: () => "Guest",
    unsupportedBrowserReason: () => options.unsupported ?? null,
    random: () => 0.5,
    diagnostic,
  });

  /** Answer the oldest unanswered request, then let the session react. */
  const answer = async (response: JoinMeetingResult | Error) => {
    const pending = requests.shift();
    if (!pending) throw new Error("No join request is waiting for an answer");
    if (response instanceof Error) pending.reject(response);
    else pending.resolve(response);
    await vi.advanceTimersByTimeAsync(0);
  };

  const connect = () => {
    const link = session.getSnapshot().link;
    if (!link) throw new Error("No link to connect");
    session.linkConnected(link.id);
    return link;
  };

  return {
    session,
    requests,
    releaseAccess,
    admissionIds,
    diagnostic,
    setStoredAdmissionId: (id: string | undefined) => {
      storedAdmissionId = id;
    },
    answer,
    connect,
    snapshot: () => session.getSnapshot(),
  };
}

const submission: PreJoinSubmission = {
  audioEnabled: true,
  videoEnabled: true,
  audioDeviceId: "mic-1",
  videoDeviceId: "cam-1",
  captionLanguage: "de-DE",
  displayName: "Ada",
  bgMode: "none",
  bgImagePath: null,
};

async function joinAndConnect(h: ReturnType<typeof createHarness>) {
  h.session.submitPreJoin(submission);
  await vi.advanceTimersByTimeAsync(0);
  await h.answer(joined());
  return h.connect();
}

beforeEach(() => {
  vi.useFakeTimers();
  generation = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Joining ──────────────────────────────────────────────────────────────────

describe("joining", () => {
  it("goes from the pre-join screen to a connected room", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    expect(h.snapshot().phase).toBe("joining");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests[0].request).toMatchObject({ displayName: "Ada", captionLanguage: "de-DE" });

    await h.answer(joined(access({ admissionId: "admission-9" })));
    expect(h.snapshot().phase).toBe("connecting");
    expect(h.snapshot().link).toMatchObject({ token: "token-1", peer: "standard" });
    expect(h.admissionIds.persist).toHaveBeenCalledWith("admission-9");

    h.connect();
    expect(h.snapshot().phase).toBe("connected");
  });

  it("refuses to start in a browser that cannot place calls", () => {
    const h = createHarness({ unsupported: "Open this in Chrome." });
    h.session.submitPreJoin(submission);
    expect(h.snapshot()).toMatchObject({ phase: "failed", failure: { message: "Open this in Chrome." } });
    expect(h.requests).toHaveLength(0);
  });

  it("ignores a second submission while the first is in progress", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests).toHaveLength(1);
  });

  it("shows a final refusal with its code", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(blocked("PLAN_LIMIT_REACHED", false));
    expect(h.snapshot()).toMatchObject({
      phase: "failed",
      failure: { code: "PLAN_LIMIT_REACHED", message: "Meeting is full." },
    });
  });

  it("retries a passing refusal, then reports it once the schedule is spent", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [1_000, 3_000, 7_000]) {
      await h.answer(blocked("MEDIA_UNAVAILABLE", true));
      expect(h.snapshot().phase).toBe("joining");
      await vi.advanceTimersByTimeAsync(delay);
    }
    await h.answer(blocked("MEDIA_UNAVAILABLE", true));
    expect(h.snapshot()).toMatchObject({ phase: "failed", failure: { code: "MEDIA_UNAVAILABLE" } });
  });

  it("retries a request that threw without reaching the endpoint", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(new Error("fetch failed"));
    expect(h.snapshot().phase).toBe("joining");
    await vi.advanceTimersByTimeAsync(1_000);
    await h.answer(joined());
    expect(h.snapshot().phase).toBe("connecting");
  });

  it("names every request of one first join with the same key, and none after", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    const key = h.requests[0].request.firstJoinKey;
    expect(key).toEqual(expect.any(String));
    // The answer is lost; the retry is the same first join.
    await h.answer(new Error("fetch failed"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.requests[0].request.firstJoinKey).toBe(key);
    await h.answer(joined());

    // Rejoining reconnects to the admission the server named.
    h.session.linkDisconnected(h.connect().id, DisconnectReason.SIGNAL_CLOSE);
    await vi.advanceTimersByTimeAsync(AUTO_REJOIN_DELAYS_MS[0]);
    expect(h.requests[0].request).toMatchObject({ reconnectAdmissionId: "admission-1", firstJoinKey: undefined });
  });

  it("starts a new first join once the admission it reconnected to is dropped", async () => {
    const h = createHarness();
    h.setStoredAdmissionId("stale");
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(blocked("FORBIDDEN", false));
    const first = h.requests[0].request.firstJoinKey;
    expect(first).toEqual(expect.any(String));
    await h.answer(waitingForApproval());
    await vi.advanceTimersByTimeAsync(5_000);
    await h.answer(blocked("MEETING_ADMISSION_DENIED", false));

    h.session.retry();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests[0].request.firstJoinKey).toEqual(expect.any(String));
    expect(h.requests[0].request.firstJoinKey).not.toBe(first);
  });

  it("drops a rejected stored admission id and asks again as a first-time joiner", async () => {
    const h = createHarness();
    h.setStoredAdmissionId("stale");
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests[0].request.reconnectAdmissionId).toBe("stale");
    await h.answer(blocked("FORBIDDEN", false));
    expect(h.admissionIds.clear).toHaveBeenCalled();
    expect(h.requests[0].request.reconnectAdmissionId).toBeUndefined();
    await h.answer(joined());
    expect(h.snapshot().phase).toBe("connecting");
  });

  it("releases an admitted answer that arrived without credentials", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(joined(access({ token: "" })));
    expect(h.snapshot().phase).toBe("failed");
    expect(h.releaseAccess).toHaveBeenCalledTimes(1);
  });
});

// ── Late and competing answers ───────────────────────────────────────────────

describe("late and competing answers", () => {
  it("adopts a timed-out request's late admission when nothing else has been admitted", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(h.snapshot().phase).toBe("joining");

    await h.answer(joined());
    expect(h.snapshot().phase).toBe("connecting");
    expect(h.releaseAccess).not.toHaveBeenCalled();
  });

  it("releases a late admission once a newer request has been adopted", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25_000 + 1_000);
    expect(h.requests).toHaveLength(2);

    const [first, second] = h.requests.splice(0, 2);
    second.resolve(joined(access({ connectionId: "connection-new" })));
    await vi.advanceTimersByTimeAsync(0);
    const adopted = h.snapshot().link;

    first.resolve(joined(access({ connectionId: "connection-old" })));
    await vi.advanceTimersByTimeAsync(0);

    expect(h.snapshot().link).toBe(adopted);
    expect(h.releaseAccess).toHaveBeenCalledWith({ meetingId: "meeting-1", connectionId: "connection-old" });
  });

  it("releases an older request's admission even when it arrives first (review bug #2)", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25_000 + 1_000);
    const [first, second] = h.requests.splice(0, 2);
    expect(first.request.clientAttemptId).not.toBe(second.request.clientAttemptId);

    first.resolve(joined(access({ connectionId: "connection-old", token: "old" })));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.snapshot().link).toBeNull();
    expect(h.releaseAccess).toHaveBeenCalledWith({ meetingId: "meeting-1", connectionId: "connection-old" });

    second.resolve(joined(access({ connectionId: "connection-new", token: "new" })));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.snapshot().link?.token).toBe("new");
    expect(h.releaseAccess).toHaveBeenCalledTimes(1);
  });

  it("releases an admission that lands after the page stopped showing the session", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    h.session.deactivate();
    await h.answer(joined());
    expect(h.releaseAccess).toHaveBeenCalledTimes(1);
  });

  it("carries on a join when the page is shown again before its answer lands", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    h.session.deactivate();
    h.session.activate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests).toHaveLength(2);

    // The answer to the request from before is released, not adopted.
    await h.answer(joined(access({ connectionId: "connection-old" })));
    expect(h.releaseAccess).toHaveBeenCalledWith({ meetingId: "meeting-1", connectionId: "connection-old" });
    expect(h.snapshot().phase).toBe("joining");

    await h.answer(joined(access({ token: "new" })));
    expect(h.snapshot()).toMatchObject({ phase: "connecting", link: { token: "new" } });
  });

  it("keeps a wait between requests to its schedule, hidden or not", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(blocked("MEDIA_UNAVAILABLE", true));
    // The second request is due a second after the first failed.
    await vi.advanceTimersByTimeAsync(400);
    h.session.deactivate();
    await vi.advanceTimersByTimeAsync(300);
    h.session.activate();

    await vi.advanceTimersByTimeAsync(299);
    expect(h.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.requests).toHaveLength(1);
    await h.answer(joined());
    expect(h.snapshot().phase).toBe("connecting");
  });

  it("sends a request that fell due while hidden as soon as it is shown again", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(blocked("MEDIA_UNAVAILABLE", true));
    h.session.deactivate();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.requests).toHaveLength(0);
    h.session.activate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests).toHaveLength(1);
    await h.answer(joined());
    expect(h.snapshot().phase).toBe("connecting");
  });

  it("does nothing while hidden, and resumes nothing for a page that was idle", async () => {
    const h = createHarness();
    h.session.deactivate();
    h.session.submitPreJoin(submission);
    h.session.activate();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.requests).toEqual([]);
    expect(h.snapshot().phase).toBe("prejoin");
  });

  it("ignores events from a connection the session has moved past", async () => {
    const h = createHarness();
    const oldLink = await joinAndConnect(h);
    h.session.linkDisconnected(oldLink.id, undefined);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(joined());

    h.session.linkDisconnected(oldLink.id, DisconnectReason.DUPLICATE_IDENTITY);
    expect(h.snapshot().phase).toBe("connecting");
  });
});

// ── The lobby ────────────────────────────────────────────────────────────────

describe("the lobby", () => {
  it("waits for approval and polls until admitted", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(waitingForApproval("admission-w"));
    expect(h.snapshot()).toMatchObject({
      phase: "prejoin",
      lobby: { reason: "approval", requestId: "admission-w" },
    });
    expect(h.admissionIds.persist).toHaveBeenCalledWith("admission-w");

    await vi.advanceTimersByTimeAsync(5_000);
    await h.answer(waitingForApproval("admission-w"));
    await vi.advanceTimersByTimeAsync(5_000);
    await h.answer(joined());
    expect(h.snapshot()).toMatchObject({ phase: "connecting", lobby: null });
    // The wait is reported once, not on every poll.
    expect(h.diagnostic.mock.calls.filter(([event]) => event === "admission_pending")).toHaveLength(1);
  });

  it("keeps polling once the page is shown again", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(waitingForApproval());
    h.session.deactivate();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.requests).toHaveLength(0);

    h.session.activate();
    await vi.advanceTimersByTimeAsync(5_000);
    await h.answer(joined());
    expect(h.snapshot()).toMatchObject({ phase: "connecting", lobby: null });
  });

  it("stays in the lobby through passing failures, polling more slowly", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(waitingForApproval());
    await vi.advanceTimersByTimeAsync(5_000);
    await h.answer(blocked("RATE_LIMITED", true));
    expect(h.snapshot().phase).toBe("prejoin");

    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.requests).toHaveLength(1);
  });

  it("leaves the lobby for a denial and forgets the admission", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(waitingForApproval());
    await vi.advanceTimersByTimeAsync(5_000);
    await h.answer(blocked("MEETING_ADMISSION_DENIED", false));
    expect(h.snapshot()).toMatchObject({ phase: "failed", failure: { code: "MEETING_ADMISSION_DENIED" } });
    expect(h.admissionIds.clear).toHaveBeenCalled();
  });

  it("joins with the choices made while waiting", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(waitingForApproval());
    h.session.updateLobbyChoices({ ...submission, videoEnabled: false, captionLanguage: "fr-FR" });
    expect(h.session.intent.get()).toMatchObject({ videoEnabled: false });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.requests[0].request.captionLanguage).toBe("fr-FR");
  });
});

// ── Recovery ─────────────────────────────────────────────────────────────────

describe("recovery after losing an established connection", () => {
  it("rejoins naming the node it lost", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    h.session.linkDisconnected(link.id, undefined);
    expect(h.snapshot()).toMatchObject({ phase: "recovering", link: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests[0].request.unreachableMediaUrl).toBe("wss://node-a.test");
  });

  it("carries on recovering once the page is shown again, still naming the node it lost", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    h.session.linkDisconnected(link.id, undefined);
    h.session.deactivate();
    h.session.activate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].request.unreachableMediaUrl).toBe("wss://node-a.test");
    await h.answer(joined());
    expect(h.snapshot().phase).toBe("connecting");
  });

  it("keeps retrying a passing refusal instead of failing on the first one", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    h.session.linkDisconnected(link.id, undefined);
    await vi.advanceTimersByTimeAsync(0);

    await h.answer(blocked("MEDIA_UNAVAILABLE", true));
    expect(h.snapshot().phase).toBe("recovering");
    await vi.advanceTimersByTimeAsync(AUTO_REJOIN_DELAYS_MS[1]);
    await h.answer(blocked("CONFLICT", true));
    expect(h.snapshot().phase).toBe("recovering");
    await vi.advanceTimersByTimeAsync(AUTO_REJOIN_DELAYS_MS[2]);
    await h.answer(joined());
    expect(h.snapshot().phase).toBe("connecting");
  });

  it("rejoins as soon as the page that lost the connection is shown again", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    h.session.linkDisconnected(link.id, undefined);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(blocked("MEDIA_UNAVAILABLE", true));
    await vi.advanceTimersByTimeAsync(AUTO_REJOIN_DELAYS_MS[1]);
    await h.answer(blocked("MEDIA_UNAVAILABLE", true));

    // Back from another tab with the next request seconds away: send it now.
    h.session.pageShown();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests).toHaveLength(1);
    await h.answer(joined());
    expect(h.snapshot().phase).toBe("connecting");
  });

  it("does not hurry a first join or an answer already on its way", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(blocked("MEDIA_UNAVAILABLE", true));
    h.session.pageShown();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests).toHaveLength(0);

    const link = await (async () => {
      await vi.advanceTimersByTimeAsync(AUTO_REJOIN_DELAYS_MS[1]);
      await h.answer(joined());
      const connected = h.connect();
      h.session.linkConnected(connected.id);
      return connected;
    })();
    h.session.linkDisconnected(link.id, undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests).toHaveLength(1);
    h.session.pageShown();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests).toHaveLength(1);
  });

  it("gives up after the whole schedule and releases the unused access", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    h.session.linkDisconnected(link.id, undefined);
    for (const delay of AUTO_REJOIN_DELAYS_MS.slice(1)) {
      await vi.advanceTimersByTimeAsync(0);
      await h.answer(blocked("MEDIA_UNAVAILABLE", true));
      await vi.advanceTimersByTimeAsync(delay);
    }
    await h.answer(blocked("MEDIA_UNAVAILABLE", true));
    expect(h.snapshot()).toMatchObject({
      phase: "failed",
      failure: { message: "Disconnected from meeting. Please rejoin." },
    });
    expect(h.releaseAccess).toHaveBeenCalledTimes(1);
  });

  it("continues the same schedule when a rejoined connection fails to connect", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    h.session.linkDisconnected(link.id, undefined);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(joined());
    const retried = h.snapshot().link!;
    h.session.linkError(retried.id, new Error("pc failed"));
    expect(h.snapshot().phase).toBe("recovering");

    await vi.advanceTimersByTimeAsync(AUTO_REJOIN_DELAYS_MS[1] - 1);
    expect(h.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.requests).toHaveLength(1);
  });

  it("starts a full schedule again after reconnecting", async () => {
    const h = createHarness();
    let link = await joinAndConnect(h);
    h.session.linkDisconnected(link.id, undefined);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(blocked("MEDIA_UNAVAILABLE", true));
    await vi.advanceTimersByTimeAsync(AUTO_REJOIN_DELAYS_MS[1]);
    await h.answer(joined());
    link = h.connect();

    h.session.linkDisconnected(link.id, undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests).toHaveLength(1);
  });

  it("ends on the error screen for a duplicate identity", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    h.session.linkDisconnected(link.id, DisconnectReason.DUPLICATE_IDENTITY);
    expect(h.snapshot()).toMatchObject({
      phase: "failed",
      failure: { message: "This meeting is open in another tab or device." },
    });
    expect(h.releaseAccess).not.toHaveBeenCalled();
  });

  it("reports an ended meeting when the room is deleted", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    h.session.linkDisconnected(link.id, DisconnectReason.ROOM_DELETED);
    expect(h.snapshot()).toMatchObject({ phase: "ended", link: null });
    expect(h.snapshot().access?.meetingId).toBe("meeting-1");
  });

  it("retries once in compatibility mode when the signal server is unreachable", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(joined());
    const standard = h.snapshot().link!;
    h.session.linkError(standard.id, ConnectionError.serverUnreachable("no signal"));
    const compat = h.snapshot().link!;
    expect(compat).toMatchObject({ peer: "compat", token: standard.token });
    expect(compat.id).not.toBe(standard.id);

    h.session.linkError(compat.id, ConnectionError.serverUnreachable("still no signal"));
    expect(h.snapshot()).toMatchObject({ phase: "recovering", link: null });
  });

  it("ignores a cancelled connect", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(joined());
    const link = h.snapshot().link!;
    h.session.linkError(link.id, ConnectionError.cancelled("unmounted"));
    expect(h.snapshot().link).toBe(link);
  });
});

describe("removal by the server", () => {
  it("asks the join endpoint why, and shows its answer", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    h.session.linkDisconnected(link.id, DisconnectReason.PARTICIPANT_REMOVED);
    expect(h.snapshot().phase).toBe("recovering");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests[0].request.unreachableMediaUrl).toBeUndefined();
    await h.answer(blocked("PLAN_LIMIT_REACHED", false));
    expect(h.snapshot()).toMatchObject({ phase: "failed", failure: { code: "PLAN_LIMIT_REACHED" } });
  });

  it("names the connection it lost, and stops when another tab took it over", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    const lost = h.snapshot().access?.connectionId;
    h.session.linkDisconnected(link.id, DisconnectReason.PARTICIPANT_REMOVED);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests[0].request.replacesConnectionId).toBe(lost);
    await h.answer(blocked("MEETING_OPEN_ELSEWHERE", false));
    expect(h.snapshot()).toMatchObject({ phase: "failed", failure: { code: "MEETING_OPEN_ELSEWHERE" } });
  });

  it("names the meeting it was in, and takes its end as the end", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    h.session.linkDisconnected(link.id, DisconnectReason.PARTICIPANT_REMOVED);
    await vi.advanceTimersByTimeAsync(0);
    // The server must never answer with the link's next meeting.
    expect(h.requests[0].request.resumeMeetingId).toBe("meeting-1");
    await h.answer(blocked("MEETING_ENDED", false));
    expect(h.snapshot()).toMatchObject({ phase: "ended", access: { meetingId: "meeting-1" } });
  });

  it("takes an end heard while recovering a lost connection as the end", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    h.session.linkDisconnected(link.id, DisconnectReason.SIGNAL_CLOSE);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests[0].request.resumeMeetingId).toBe("meeting-1");
    await h.answer(blocked("MEETING_ENDED", false));
    expect(h.snapshot().phase).toBe("ended");
  });

  it("does not name a meeting on a first join", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests[0].request.resumeMeetingId).toBeUndefined();
  });

  it("rechecks each of two removals far apart in one meeting", async () => {
    const h = createHarness();
    let link = await joinAndConnect(h);
    h.session.linkDisconnected(link.id, DisconnectReason.PARTICIPANT_REMOVED);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(joined());
    link = h.connect();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    h.session.linkDisconnected(link.id, DisconnectReason.PARTICIPANT_REMOVED);
    expect(h.snapshot().phase).toBe("recovering");
  });

  it("stops at a second removal right after a recheck", async () => {
    const h = createHarness();
    let link = await joinAndConnect(h);
    h.session.linkDisconnected(link.id, DisconnectReason.PARTICIPANT_REMOVED);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(joined());
    link = h.connect();

    h.session.linkDisconnected(link.id, DisconnectReason.PARTICIPANT_REMOVED);
    expect(h.snapshot()).toMatchObject({
      phase: "failed",
      failure: { message: "You were removed from the meeting." },
    });
  });
});

// ── Leaving and ending ───────────────────────────────────────────────────────

describe("leaving and ending", () => {
  it("expects the disconnect that follows a leave", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    h.session.beginLeave();
    h.session.linkDisconnected(link.id, DisconnectReason.PARTICIPANT_REMOVED);
    expect(h.snapshot().phase).toBe("leaving");
    expect(h.requests).toHaveLength(0);
  });

  it("lets a participant's own leave win over a meeting-ended notice", async () => {
    const h = createHarness();
    await joinAndConnect(h);
    h.session.beginLeave();
    h.session.meetingEnded();
    expect(h.snapshot().phase).toBe("leaving");
  });

  it("returns to the pre-join screen on retry", async () => {
    const h = createHarness();
    h.session.submitPreJoin(submission);
    await vi.advanceTimersByTimeAsync(0);
    await h.answer(blocked("NOT_FOUND", false));
    h.session.retry();
    expect(h.snapshot()).toMatchObject({ phase: "prejoin", failure: null, access: null });
    h.session.submitPreJoin(submission);
    expect(h.snapshot().phase).toBe("joining");
  });
});

// ── The participant's choices ────────────────────────────────────────────────

describe("the participant's choices across connections", () => {
  it("carries choices made in the meeting into the rejoin", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    h.session.intent.update({ audioEnabled: false, videoEnabled: false, captionLanguage: "es-ES" });

    h.session.linkDisconnected(link.id, undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests[0].request.captionLanguage).toBe("es-ES");
    expect(h.session.intent.get()).toMatchObject({ audioEnabled: false, videoEnabled: false });
  });

  it("merges token updates into the access without replacing the connection", async () => {
    const h = createHarness();
    const link = await joinAndConnect(h);
    h.session.accessUpdated({ token: "refreshed" });
    expect(h.snapshot().access?.token).toBe("refreshed");
    expect(h.snapshot().link).toBe(link);
  });
});

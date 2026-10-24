import { RoomEvent, type RemoteParticipant, type Room } from "@livekit/rtc-node";

const CHECK_INTERVAL_MS = 30_000;
/** Longer than LiveKit takes to resume or rejoin a dropped signal connection. */
const DISCONNECTED_GRACE_MS = 60_000;
/**
 * Consecutive server checks that must miss the publisher. One miss can be a
 * rejoin in flight; the publisher's rejoin also gets a job of its own.
 */
const ABSENT_CHECKS_TO_LEAVE = 2;

/** Whether the LiveKit server lists the publisher in the room; null when it cannot tell. */
export type PublisherPresence = () => Promise<boolean | null>;

export interface DepartureOptions {
  checkPresence?: PublisherPresence;
  intervalMs?: number;
  disconnectedGraceMs?: number;
  now?: () => number;
}

/**
 * Resolves, with the reason, once the job's publisher is gone.
 *
 * LiveKit's events are the fast path. They are not the only one: a
 * connection that dies without a close frame fires nothing, and the job would
 * hold its process for good. So the room is also checked on an interval,
 * locally for a connection that stays down, and against the server's own
 * participant list for a publisher who left unannounced.
 */
export function waitForDeparture(room: Room, identity: string, options: DepartureOptions = {}): Promise<string> {
  const now = options.now ?? Date.now;
  return new Promise((resolve) => {
    let settled = false;
    let disconnectedSince: number | null = null;
    let absentChecks = 0;
    let checking = false;
    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.off(RoomEvent.Disconnected, onRoomDisconnected);
      resolve(reason);
    };
    const onParticipantDisconnected = (participant: RemoteParticipant) => {
      if (participant.identity === identity) finish("publisher left the room");
    };
    const onRoomDisconnected = () => finish("LiveKit room disconnected");

    const check = async () => {
      if (settled || checking) return;
      checking = true;
      try {
        if (!room.isConnected) {
          disconnectedSince ??= now();
          const downFor = now() - disconnectedSince;
          if (downFor >= (options.disconnectedGraceMs ?? DISCONNECTED_GRACE_MS)) {
            finish(`LiveKit connection down for ${Math.round(downFor / 1_000)}s`);
          }
          return;
        }
        disconnectedSince = null;
        if (!options.checkPresence) return;
        const present = await options.checkPresence();
        if (present === null) return;
        absentChecks = present ? 0 : absentChecks + 1;
        if (absentChecks >= ABSENT_CHECKS_TO_LEAVE) finish("the LiveKit server no longer lists the publisher");
      } finally {
        checking = false;
      }
    };
    const watchdog = setInterval(() => void check(), options.intervalMs ?? CHECK_INTERVAL_MS);
    watchdog.unref?.();

    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.on(RoomEvent.Disconnected, onRoomDisconnected);
    // Register first, then inspect, so a departure between the two is not missed.
    if (!room.remoteParticipants.has(identity)) finish("publisher left the room");
  });
}

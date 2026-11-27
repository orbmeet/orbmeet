import "@tanstack/react-start/server-only";
import { rpcValueOf } from "@/platform/runtime/rpc-result";

const ROOM_CALL_ATTEMPTS = 3;
const ROOM_CALL_BACKOFF_MS = 100;
/**
 * How long a join or a command waits in its meeting's room before the room
 * refuses it: inside the 25s a joining client waits for its answer, with room
 * for the Worker's own work around the call.
 */
const ROOM_CALL_PATIENCE_MS = 20_000;

type MeetingRoomStub = ReturnType<Env["MEETING_ROOM"]["get"]>;
type MeetingRoomRequest = Parameters<MeetingRoomStub["handle"]>[0];
type MeetingRoomResult = Awaited<ReturnType<MeetingRoomStub["handle"]>>;
type MeetingRoomReply = ReturnType<typeof rpcValueOf<MeetingRoomResult extends { ok: true; value: infer V } ? V : never>>;

/**
 * Send one RPC request to a meeting's `MeetingRoom` Durable Object, retrying
 * transient DO resets on a fresh stub.
 */
export async function sendMeetingRoomRpc(
  env: Pick<Env, "MEETING_ROOM">,
  request: MeetingRoomRequest,
): Promise<MeetingRoomReply> {
  if ((request.kind === "join" || request.kind === "command") && request.deadline === undefined) {
    request = { ...request, deadline: Date.now() + ROOM_CALL_PATIENCE_MS };
  }
  for (let attempt = 1; ; attempt += 1) {
    let result: MeetingRoomResult;
    try {
      const room = env.MEETING_ROOM.get(env.MEETING_ROOM.idFromName(request.meetingId));
      result = await room.handle(request);
    } catch (error) {
      const { retryable, overloaded } = (error ?? {}) as { retryable?: boolean; overloaded?: boolean };
      if (!retryable || overloaded || attempt >= ROOM_CALL_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, ROOM_CALL_BACKOFF_MS * 2 ** attempt * Math.random()));
      continue;
    }
    return rpcValueOf(result);
  }
}

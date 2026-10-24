import { DurableObject } from "cloudflare:workers";
import { withLogContext } from "@/platform/runtime/log-context";
import { rpcResultOf, type RpcResult } from "@/platform/runtime/rpc-result";
import type { CoordinatorReply, CoordinatorRequest } from "./api";
import { SlottedMeetingStore } from "./meeting-store";
import type { MeetingRoomHost } from "./room.server";

export type RoomResult = RpcResult<CoordinatorReply>;

const MEETING_ID_KEY = "meetingId";

/**
 * One open meeting, addressed by its id. The Durable Object only adapts the
 * runtime to {@link MeetingRoomHost}, which holds the logic; the host loads on
 * first use, for the same reason the Worker's server graphs do (see
 * worker-entry.ts).
 */
export class MeetingRoom extends DurableObject<Env> {
  private host: Promise<MeetingRoomHost> | null = null;

  handle(request: CoordinatorRequest): Promise<RoomResult> {
    return withLogContext({ meetingId: request.meetingId }, () =>
      rpcResultOf("meetings", async () => (await this.hostFor(request.meetingId)).handle(request)));
  }

  async alarm(): Promise<void> {
    const meetingId = await this.ctx.storage.get<string>(MEETING_ID_KEY);
    if (!meetingId) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await withLogContext({ meetingId }, async () => (await this.hostFor(meetingId)).alarm());
  }

  /** Test and operator hook: resolves once running effects have settled. */
  async idle(): Promise<void> {
    if (this.host) await (await this.host).idle();
  }

  private hostFor(meetingId: string): Promise<MeetingRoomHost> {
    this.host ??= (async () => {
      const { MeetingRoomHost } = await import("./room.server");
      const storage = this.ctx.storage;
      // The meeting's id is kept with its state, for the alarm: an object whose
      // meeting was refused on first contact keeps nothing at all.
      const store = new SlottedMeetingStore(storage, meetingId);
      return new MeetingRoomHost(this.env, meetingId, {
        load: () => store.load(),
        save: (state, projectedFrom) => store.save(state, projectedFrom),
        projected: () => store.projected(),
        clear: async () => {
          await storage.deleteAlarm();
          await store.clear();
        },
        setAlarm: async (at) => {
          if (at === null) await storage.deleteAlarm();
          else await storage.setAlarm(at);
        },
      });
    })().catch((error: unknown) => {
      // Let the next request load it again rather than keep the failure.
      this.host = null;
      throw error;
    });
    return this.host;
  }
}

import type { MeetingRoom } from "@/modules/meetings/server/runtime/meeting-room";
import type { SerialScope } from "@/app/serial/serial-scope";

// Config-derived types bind Durable Object namespaces unparameterized; these
// restore the RPC surfaces the classes actually expose, for both the global
// Env and the `Cloudflare.Env` the vitest plugin types `cloudflare:workers`
// with.
declare global {
  namespace Cloudflare {
    interface Env {
      MEETING_ROOM: DurableObjectNamespace<MeetingRoom>;
      SERIAL_SCOPES: DurableObjectNamespace<SerialScope>;
    }
  }

  const __STYLEX_DEV__: boolean;

  interface Env {
    MEETING_ROOM: DurableObjectNamespace<MeetingRoom>;
    SERIAL_SCOPES: DurableObjectNamespace<SerialScope>;
    AI_API_KEY?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    UPTIMEROBOT_API_KEY?: string;
    PADDLE_API_KEY?: string;
    PADDLE_WEBHOOK_SECRET?: string;
    EMAIL_FROM_ADDRESS?: string;
    MATHINK_ORIGIN_SECRET?: string;
    /** Shared with the orbmeet-code-runner Worker; absent locally. */
    CODE_RUNNER_SECRET?: string;
    /** Local code runner URL for development. */
    CODE_RUNNER_URL?: string;
  }
}

export {};

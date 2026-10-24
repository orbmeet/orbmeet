import { LogLevel, setLogLevel } from "livekit-client";

let configured = false;

export function configureLiveKitLogging(): void {
  if (configured) return;
  configured = true;
  if (typeof window === "undefined") return;

  setLogLevel(import.meta.env.DEV ? LogLevel.info : LogLevel.warn);
}

import type { ComponentType } from "react";
import type { RecorderWhiteboardProps } from "@orbmeet/whiteboard-client/recorder";

export type RecorderStatus = "loading" | "ready" | "error";

export interface RecorderModule {
  RecorderWhiteboard: ComponentType<RecorderWhiteboardProps>;
}

export async function loadRecorderModule(): Promise<RecorderModule> {
  const module = await import("@orbmeet/whiteboard-client/recorder");
  return { RecorderWhiteboard: module.RecorderWhiteboard };
}

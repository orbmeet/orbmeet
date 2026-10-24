import type { ComponentType } from "react";
import type { WhiteboardClientCapabilities, WhiteboardServiceEndpoints } from "@orbmeet/whiteboard-client/react";

export type RecorderStatus = "loading" | "ready" | "error";

interface RecorderWhiteboardProps {
  capabilities: WhiteboardClientCapabilities;
  licenseKey?: string;
  whiteboardUrl: string;
  recorderToken: string;
  /** The board the meeting presents; the recorder follows it. */
  whiteboardId: string | null;
  /** Host-supplied application endpoints (recorder auth exchange). */
  serviceEndpoints: WhiteboardServiceEndpoints;
  onStatusChange?: (status: RecorderStatus) => void;
  onContentStateChange?: (hasContent: boolean) => void;
}

export interface RecorderModule {
  RecorderWhiteboard: ComponentType<RecorderWhiteboardProps>;
}

export async function loadRecorderModule(): Promise<RecorderModule> {
  const module = await import("@orbmeet/whiteboard-client/react");
  return { RecorderWhiteboard: module.RecorderWhiteboard };
}

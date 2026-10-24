import "@tanstack/react-start/server-only";
import { whiteboardNodes as nodesRunningWhiteboard, type WhiteboardNode } from "@/platform/realtime/nodes";

export type { WhiteboardNode };

/**
 * The nodes running a whiteboard sync server, from NODES. Each has its own
 * keyrings; which one holds a board is in D1. Empty when NODES is unusable:
 * the pages still render, and anything that needs a node reports the
 * configuration error.
 */
export function whiteboardNodes(env: Pick<Env, "NODES">): WhiteboardNode[] {
  try {
    return [...nodesRunningWhiteboard(env).values()];
  } catch {
    return [];
  }
}

/** Whether boards can be used at all: some node runs a sync server. */
export function isWhiteboardConfigured(env: Pick<Env, "NODES">): boolean {
  return whiteboardNodes(env).length > 0;
}

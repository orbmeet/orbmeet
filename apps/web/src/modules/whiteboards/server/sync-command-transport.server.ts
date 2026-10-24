import "@tanstack/react-start/server-only";
import {
  parseSyncCommandResult,
  SYNC_PROTOCOL,
  SYNC_PROTOCOL_HEADER,
  syncCommandFailure,
  syncCommandPath,
  type SyncCommandFailure,
  type SyncCommandName,
  type SyncCommandRequest,
  type SyncCommandResult,
} from "@orbmeet/whiteboard-core/sync-commands";
import { logError, logWarn } from "@/lib/logger";
import { postSignedJson } from "@/platform/http/internal-auth";
import type { WhiteboardNode } from "./config.server";

/**
 * How long each command may take. A command that may read or write a stored
 * snapshot or a saved room in R2 gets the long budget. Every command must
 * choose: one added to `SyncCommands` does not typecheck until it is listed
 * here.
 */
const SHORT_TIMEOUT_MS = 6_000;
const LONG_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS: Record<SyncCommandName, number> = {
  open: LONG_TIMEOUT_MS,
  capture: LONG_TIMEOUT_MS,
  archive: LONG_TIMEOUT_MS,
  reopen: LONG_TIMEOUT_MS,
  restore: LONG_TIMEOUT_MS,
  seed: LONG_TIMEOUT_MS,
  handoff: LONG_TIMEOUT_MS,
  purge: LONG_TIMEOUT_MS,
  copySnapshot: LONG_TIMEOUT_MS,
  readSnapshot: LONG_TIMEOUT_MS,
  pageAdd: LONG_TIMEOUT_MS,
  refreshAuthority: SHORT_TIMEOUT_MS,
  editRequest: SHORT_TIMEOUT_MS,
  editResolve: SHORT_TIMEOUT_MS,
  pageEditValidate: SHORT_TIMEOUT_MS,
  pagePresentValidate: SHORT_TIMEOUT_MS,
  navigationControllerSet: SHORT_TIMEOUT_MS,
  navigationControllerRelease: SHORT_TIMEOUT_MS,
};

/** A command that never reached the node, or got no answer from it: not something the node decided. */
export function isUnreachable(result: SyncCommandResult<SyncCommandName>): boolean {
  return !result.ok && result.details?.unreachable === true;
}

function unreachable(): SyncCommandFailure {
  return syncCommandFailure("unavailable", "Whiteboard service unavailable", { unreachable: true });
}

/** One command to one node, signed with that node's command key, answered with its typed result. */
export async function postSyncCommand<C extends SyncCommandName>(
  node: WhiteboardNode,
  name: C,
  body: SyncCommandRequest<C>,
  timeoutMs = COMMAND_TIMEOUT_MS[name],
): Promise<SyncCommandResult<C>> {
  let response: Response;
  try {
    response = await postSignedJson(
      `${node.whiteboardUrl}${syncCommandPath(name)}`,
      body,
      node.commandKeyring,
      timeoutMs,
      { [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL.speaks) },
    );
  } catch (error) {
    logWarn("[whiteboard] command failed to reach the sync server", { name, node: node.id }, error);
    return unreachable();
  }
  if (response.status === 401) {
    // Only a key mismatch between the two services produces this.
    logError("[whiteboard] Sync server rejected the command signature", { name, node: node.id });
    return syncCommandFailure("unavailable", "Whiteboard service unavailable");
  }
  try {
    const result = parseSyncCommandResult(await response.json());
    if (result) return result;
  } catch {
    // Fall through: anything but a typed result is an outage, not an answer.
  }
  logWarn("[whiteboard] sync server answered a command without a result", {
    name,
    node: node.id,
    status: response.status,
  });
  return unreachable();
}

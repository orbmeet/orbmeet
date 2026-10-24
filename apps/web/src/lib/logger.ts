// Structured logger for the Worker and the browser alike: @orbmeet/primitives'
// logger, which every runtime shares, so no runtime logs what another redacts.
//
// The Worker logs info and up: its lines are the record of what happened, and
// at this application's volume they cost next to nothing. A production browser
// logs only warnings and errors to its console; development logs everything.
// Both are fixed when Vite compiles the module, so a suppressed call returns
// before building an entry.

import { createLogger } from "@orbmeet/primitives";

let readContext: (() => Record<string, unknown> | undefined) | undefined;

/** Where the Worker's per-invocation fields come from (worker-entry.ts). */
export function setLogContext(read: () => Record<string, unknown> | undefined): void {
  readContext = read;
}

const logger = createLogger({
  minLevel: import.meta.env.DEV || import.meta.env.SSR ? "info" : "warn",
  context: () => readContext?.(),
});

export function logError(message: string, ...args: unknown[]): void {
  logger.error(message, ...args);
}

export function logWarn(message: string, ...args: unknown[]): void {
  logger.warn(message, ...args);
}

export function logInfo(message: string, ...args: unknown[]): void {
  logger.info(message, ...args);
}

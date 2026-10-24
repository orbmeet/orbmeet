import { createLogger } from "@orbmeet/primitives";

// The agent's one logger: @orbmeet/primitives' structured logger, shared with
// the app, so both redact the same keys and a log call never throws on what
// it is handed. One JSON line per entry.

const logger = createLogger({ minLevel: "info" });

export const logError = logger.error;
export const logWarn = logger.warn;
export const logInfo = logger.info;

import { createLogger, type LogLevel } from "@orbmeet/primitives";

// The server's one logger: @orbmeet/primitives' structured logger, which the
// Worker shares, so both redact the same keys and neither can fail to log a
// cyclic or unserializable value. With LOG_FORMAT=json (production) each
// entry is one JSON line, errors on stderr; otherwise it is a line a terminal
// reads, built from the same redacted entry.

const json = (process.env.LOG_FORMAT ?? "plain").toLowerCase() === "json";

function writePlain(level: LogLevel, _line: string, entry: Record<string, unknown>): void {
  const { ts: _ts, level: _level, msg, ...rest } = entry;
  const detail = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
  const text = `${String(msg)}${detail}`;
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.info(text);
}

function writeJson(level: LogLevel, line: string): void {
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

const logger = createLogger({ minLevel: "info", write: json ? writeJson : writePlain });

export const logError = logger.error;
export const logWarn = logger.warn;
export const logInfo = logger.info;

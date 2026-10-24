/**
 * An error carrying the machine-readable fields the CLI prints on stderr.
 * Anything else that reaches the top level is reported as CLI_ERROR.
 */
export class CliError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, options: { code?: string; details?: unknown } = {}) {
    super(message);
    this.name = "CliError";
    this.code = options.code ?? "CLI_ERROR";
    this.details = options.details;
  }
}

/** Read the `code` of a Node system error without trusting its shape. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

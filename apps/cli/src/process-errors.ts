import { errorCode } from "./errors.ts";

type Exit = (code?: number | string) => void;

export function handlePipeError(
  error: unknown,
  exit: Exit = process.exit,
  exitCode: number | string = process.exitCode ?? 1,
): void {
  if (errorCode(error) === "EPIPE") {
    exit(exitCode);
    return;
  }
  throw error;
}

export function handleStdoutError(error: unknown, exit: Exit = process.exit): void {
  return handlePipeError(error, exit, process.exitCode ?? 0);
}

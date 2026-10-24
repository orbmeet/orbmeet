import { AppError } from "@/lib/app-errors";
import { logError } from "@/lib/logger";

/** A refusal as it crosses Durable Object RPC: AppError's fields, which RPC would otherwise drop. */
interface RpcFailure {
  code: string;
  message: string;
  statusCode: number;
  data?: unknown;
}

/** What a Durable Object method answers instead of throwing, so an AppError survives RPC. */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcFailure };

/** Run `work` on the Durable Object's side, answering its value or its refusal. */
export async function rpcResultOf<T>(context: string, work: () => Promise<T>): Promise<RpcResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: rpcFailureOf(context, error) };
  }
}

/** The caller's side: the value, or the AppError the object refused with. */
export function rpcValueOf<T>(result: RpcResult<T>): T {
  if (result.ok) return result.value;
  const { code, message, statusCode, data } = result.error;
  throw new AppError(code, message, statusCode, data);
}

function rpcFailureOf(context: string, error: unknown): RpcFailure {
  const candidate = error as Partial<RpcFailure> | null;
  if (candidate && typeof candidate.code === "string" && typeof candidate.statusCode === "number") {
    return {
      code: candidate.code,
      message: typeof candidate.message === "string" ? candidate.message : "",
      statusCode: candidate.statusCode,
      ...(candidate.data !== undefined && { data: candidate.data }),
    };
  }
  logError(`[${context}] failed:`, error);
  return { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again.", statusCode: 500 };
}

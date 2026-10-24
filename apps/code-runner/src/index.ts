import * as v from "valibot";
import { DurableObject } from "cloudflare:workers";
import {
  codeRunnerCancelRequestSchema,
  codeRunnerRequestSchema,
  type CodeRunnerRequest,
} from "@orbmeet/whiteboard-core/code-run-contract";
import { timingSafeEqual } from "@orbmeet/primitives";
import { Board, INACTIVITY_TIMEOUT_MS, type CodeRunOutcome } from "./board";

export type { CodeRunOutcome } from "./board";

/**
 * One whiteboard board's sandbox: a Durable Object and the container it starts.
 *
 * `enableInternet: false` (in `Board`) is the outer line of the container
 * policy: a snippet from a meeting participant gets no egress at all. Nothing
 * needs the network — every toolchain is baked into the image and every
 * program is a single file with no dependencies to resolve.
 *
 * The board's runs are tracked here in memory, because this object *is* the
 * board: one instance per sandbox id. An instance that restarts while its
 * container keeps running loses that bookkeeping but not the container's own
 * guarantees — each slot is locked inside the container, so a new run never
 * shares a slot with one an earlier instance started.
 */
export class CodeSandbox extends DurableObject<CodeRunnerEnv> {
  readonly #board: Board;

  constructor(ctx: DurableObjectState, env: CodeRunnerEnv) {
    super(ctx, env);
    const container = ctx.container;
    if (!container) throw new Error("CodeSandbox has no container attached");
    this.#board = new Board(container, { waitUntil: (promise) => ctx.waitUntil(promise) });
    // The inactivity timeout belongs to the Durable Object instance that set it,
    // so an instance that wakes to a container already running sets it again.
    if (container.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS).catch((error: unknown) => {
          console.error("[code-runner] could not set the inactivity timeout", error);
        })
      );
    }
  }

  run(request: CodeRunnerRequest): Promise<CodeRunOutcome> {
    return this.#board.run(request);
  }

  cancelRun(runId: string): boolean {
    return this.#board.cancel(runId);
  }
}

interface CodeRunnerEnv {
  CODE_RUNNER_SECRET?: string;
}

declare global {
  namespace Cloudflare {
    /** Types `ctx.exports`: this module's exports, with CodeSandbox as a namespace. */
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "CodeSandbox";
    }
  }
}

const SECRET_HEADER = "X-Code-Runner-Secret";
const NO_STORE = { "Cache-Control": "no-store" };

export default {
  async fetch(request: Request, env: CodeRunnerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method !== "POST"
      || (url.pathname !== "/run" && url.pathname !== "/cancel")
    ) {
      return new Response("Not found", { status: 404 });
    }

    // This Worker holds no user identity of its own — apps/web has already
    // decided who may run what, and hands us the sandbox id it derived. It has
    // no public route (`workersDev: false`) and is reached through apps/web's
    // service binding; the shared secret keeps it answering only apps/web
    // should a route ever be added.
    const presented = request.headers.get(SECRET_HEADER);
    const expected = env.CODE_RUNNER_SECRET;
    if (!expected || !presented || !(await timingSafeEqual(presented, expected))) {
      return new Response("Unauthorized", { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (url.pathname === "/cancel") {
      const parsed = v.safeParse(codeRunnerCancelRequestSchema, body);
      if (!parsed.success) {
        return Response.json({ error: "Invalid cancel request" }, { status: 422 });
      }
      const { sandboxId, runId } = parsed.output;
      try {
        await ctx.exports.CodeSandbox.getByName(sandboxId).cancelRun(runId);
      } catch (error) {
        console.error("[code-runner] cancel failed", error instanceof Error ? error.stack : error);
        return Response.json({ error: "Runner unavailable" }, { status: 503, headers: NO_STORE });
      }
      return new Response(null, { status: 204, headers: NO_STORE });
    }

    const parsed = v.safeParse(codeRunnerRequestSchema, body);
    if (!parsed.success) {
      return Response.json({ error: "Invalid run request" }, { status: 422 });
    }

    try {
      const outcome = await ctx.exports.CodeSandbox.getByName(parsed.output.sandboxId).run(parsed.output);
      switch (outcome.kind) {
        case "result":
          return Response.json(outcome.result, { headers: NO_STORE });
        case "busy":
          return Response.json(
            { error: "This board is already running code" },
            { status: 429, headers: NO_STORE },
          );
        case "cancelled":
          return Response.json({ error: "Run cancelled" }, { status: 409, headers: NO_STORE });
      }
    } catch (error) {
      // Container start failures, an evicted container mid-run, a supervisor
      // that never answered or found its container unfit. None of these are
      // the snippet's fault, so they are a 503 the caller can surface as "try
      // again" rather than a result written to the board as the program's own
      // error.
      console.error("[code-runner] run failed", error instanceof Error ? error.stack : error);
      return Response.json({ error: "Runner unavailable" }, { status: 503 });
    }
  },
};

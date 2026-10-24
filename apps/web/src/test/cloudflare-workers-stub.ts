/**
 * `cloudflare:workers` for unit tests that run under Node rather than workerd.
 * Only what modules import at evaluation time is provided.
 */
export class DurableObject<E = unknown> {
  constructor(
    protected ctx: DurableObjectState,
    protected env: E,
  ) {}
}

export class WorkflowEntrypoint<E = unknown> {
  constructor(
    protected ctx: ExecutionContext,
    protected env: E,
  ) {}
}

export const env = {};

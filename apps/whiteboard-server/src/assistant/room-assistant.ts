import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { toJsonSchema } from "@valibot/to-json-schema";
import {
  ASSISTANT_EVENTS,
  audienceKey,
  CANVAS_TOOLS,
  lookedAtFromRequest,
  privateAudience,
  ROOM_AUDIENCE,
  type AssistantAudience,
  type AssistantEntry,
  type AssistantEvent,
  type AssistantPageContext,
  type AssistantRequest,
  type AssistantRun,
  type AssistantSnapshot,
  type AssistantToolResult,
  type CanvasToolName,
} from "@orbmeet/whiteboard-core/assistant";
import { RateLimiter } from "../lib/rate-limiter.ts";
import type { AssistantModel } from "./assistant-model.ts";
import { ASSISTANT_SYSTEM_PROMPT, buildPromptMessage, imageContent, type PromptAudience } from "./assistant-prompt.ts";
import { Reply } from "../http/reply.ts";
import { logError } from "../lib/log.ts";

/** How long the requester's browser has to carry out one canvas tool call. */
const TOOL_CALL_TIMEOUT_MS = 30_000;
/** Model requests in one run; a drawing with a review pass needs a handful. */
const MAX_TURNS_PER_RUN = 16;
const MAX_PROMPTS_PER_USER = 10;
const PROMPT_WINDOW_MS = 10 * 60_000;
/** What participants can scroll back through. The model's own context is pruned separately. */
const MAX_ENTRIES = 300;
/** Older screenshots are dropped from the model's context; they are large and stale. */
const MAX_IMAGES_IN_CONTEXT = 2;
const MAX_MESSAGES_IN_CONTEXT = 80;
/** Streamed reply text is broadcast at most this often. */
const REPLY_FLUSH_MS = 120;

export interface AssistantSender {
  userId: string;
  userName: string;
  connectionId: string;
}

/** The slice of the room the assistant needs. */
export interface RoomAssistantHost {
  whiteboardRoomId: string;
  /** Deliver to everyone on the board. */
  broadcast(event: AssistantEvent): void;
  /** Deliver to every session of these people, and to nobody else. */
  sendToUsers(userIds: readonly string[], event: AssistantEvent): void;
  /** Deliver to the sessions of one browser connection; returns how many were sent. */
  sendToConnection(connectionId: string, event: AssistantEvent): number;
  /** The name of someone on the board now, or null when they are not. */
  presentName(userId: string): string | null;
  canEdit(userId: string): boolean;
  canManage(userId: string): boolean;
}

interface ActiveRun extends AssistantRun {
  connectionId: string;
  pageId: string;
  canEdit: boolean;
  turns: number;
}

/** An entry as the code above writes it; `upsert` stamps its time and audience. */
type WithoutStamp<Entry> = Entry extends unknown ? Omit<Entry, "at" | "audience"> : never;
type NewEntry = WithoutStamp<AssistantEntry>;

interface PendingToolCall {
  runId: string;
  connectionId: string;
  settle(result: AssistantToolResult | Error): void;
}

/** Private conversations one room keeps; each is two people's or one person's. */
const MAX_PRIVATE_CONVERSATIONS = 200;
/** Runs going on at once in one room, across all its conversations. */
const MAX_CONCURRENT_RUNS = 4;

/**
 * One whiteboard room's assistant: the room's conversation, which everyone
 * sees, and the private ones — a person and Orb, or two people and Orb —
 * which only their members see.
 *
 * Orb answers to the same people who could see the question, so a private
 * conversation never draws: a drawing on the shared board would show the
 * whole room what was asked in private.
 */
export class RoomAssistant {
  private readonly conversations = new Map<string, AssistantConversation>();
  private readonly prompts = new RateLimiter(MAX_PROMPTS_PER_USER, PROMPT_WINDOW_MS);
  private readonly room: AssistantConversation;

  private readonly host: RoomAssistantHost;
  private readonly model: AssistantModel | null;

  constructor(
    host: RoomAssistantHost,
    model: AssistantModel | null,
  ) {
    this.host = host;
    this.model = model;
    this.room = new AssistantConversation(host, ROOM_AUDIENCE);
    this.conversations.set(audienceKey(ROOM_AUDIENCE), this.room);
  }

  /** What `viewerId` may see: the room's conversation and their own private ones. Without a viewer, the room's alone. */
  snapshot(viewerId?: string): AssistantSnapshot {
    const visible = [...this.conversations.values()].filter((conversation) => conversation.includes(viewerId));
    const entries = visible.flatMap((conversation) => conversation.entries);
    // Each conversation is in order already; the sort is stable, so ties keep it.
    entries.sort((a, b) => a.at - b.at);
    const runs = visible.flatMap((conversation) => {
      const run = conversation.publicRun();
      return run ? [run] : [];
    });
    return { available: this.model !== null, entries, run: this.room.publicRun(), runs };
  }

  handle(sender: AssistantSender, request: AssistantRequest): Reply {
    switch (request.type) {
      case "prompt":
        return this.prompt(sender, request);
      case "tool-result": {
        const conversation = [...this.conversations.values()].find((candidate) => candidate.hasPendingCall(request.callId));
        return conversation
          ? conversation.toolResult(sender, request)
          : Reply.json({ error: "No such tool call" }, 409);
      }
      case "cancel": {
        const conversation = request.runId
          ? [...this.conversations.values()].find((candidate) => candidate.runId === request.runId)
          : this.room;
        if (!conversation?.runId) return Reply.json({ ok: true });
        // In the room, the asker or a whiteboard manager; in private, anyone in it.
        const allowed = conversation.isPrivate
          ? conversation.includes(sender.userId)
          : conversation.requesterUserId === sender.userId || this.host.canManage(sender.userId);
        if (!allowed) {
          return Reply.json({ error: "Only the person who asked or a whiteboard manager can stop the assistant" }, 403);
        }
        conversation.cancel();
        return Reply.json({ ok: true });
      }
      case "clear":
        if (!this.host.canManage(sender.userId)) {
          return Reply.json({ error: "Only a whiteboard manager can clear the conversation" }, 403);
        }
        this.room.reset();
        this.host.broadcast({ type: ASSISTANT_EVENTS.SNAPSHOT, snapshot: this.snapshot() });
        return Reply.json({ ok: true });
    }
  }

  /** A browser connection went away: its pending tool calls cannot complete. */
  connectionEnded(connectionId: string): void {
    for (const conversation of this.conversations.values()) conversation.connectionEnded(connectionId);
  }

  close(): void {
    for (const conversation of this.conversations.values()) conversation.close();
    this.prompts.destroy();
  }

  private prompt(sender: AssistantSender, request: Extract<AssistantRequest, { type: "prompt" }>): Reply {
    if (!this.model) return Reply.json({ error: "The assistant is not configured" }, 503);

    const wanted = request.audience ?? { kind: "room" as const };
    let audience = ROOM_AUDIENCE;
    let partnerName: string | null = null;
    if (wanted.kind === "private") {
      if (wanted.with !== undefined && wanted.with !== sender.userId) {
        partnerName = this.host.presentName(wanted.with);
        if (partnerName === null) {
          return Reply.json({ error: "That person is not on the board" }, 409);
        }
      }
      audience = privateAudience(partnerName === null ? [sender.userId] : [sender.userId, wanted.with!]);
    }

    const key = audienceKey(audience);
    let conversation = this.conversations.get(key);
    if (conversation?.runId) return Reply.json({ error: "The assistant is busy" }, 409);
    const running = [...this.conversations.values()].filter((candidate) => candidate.runId).length;
    if (running >= MAX_CONCURRENT_RUNS) return Reply.json({ error: "The assistant is busy" }, 409);
    if (!conversation) this.dropAbandonedConversations();
    if (!conversation && this.conversations.size > MAX_PRIVATE_CONVERSATIONS) {
      return Reply.json({ error: "Too many private conversations in this room" }, 429);
    }
    if (!this.prompts.check(sender.userId)) {
      return Reply.json({ error: "Too many requests to the assistant; try again in a few minutes" }, 429);
    }
    if (!conversation) {
      conversation = new AssistantConversation(this.host, audience);
      this.conversations.set(key, conversation);
    }
    const runId = conversation.prompt(this.model, sender, request.text, request.page, {
      said: request.said,
      partnerName,
    });
    return Reply.json({ ok: true, runId });
  }

  /**
   * Forget the private conversations nobody can see any more: every member
   * has left the board and nothing is running in it. A member who comes back
   * does so under a new user id, so it would never be shown to them again,
   * and kept it would hold one of `MAX_PRIVATE_CONVERSATIONS` for as long as
   * the room stays open.
   */
  private dropAbandonedConversations(): void {
    const isPresent = (userId: string) => this.host.presentName(userId) !== null;
    for (const [key, conversation] of this.conversations) {
      if (!conversation.isAbandoned(isPresent)) continue;
      conversation.close();
      this.conversations.delete(key);
    }
  }
}

/**
 * One conversation with Orb, for one audience: one run at a time, its own
 * model context, and entries delivered to its audience and nobody else.
 *
 * The model runs here. Canvas tools run in the requester's browser, because
 * tldraw's Editor is what knows a shape's geometry; this class sends each call
 * to that connection and waits for its result. Nobody else's browser is ever
 * asked, and a requester who leaves fails the call rather than handing it on.
 */
class AssistantConversation {
  entries: AssistantEntry[] = [];
  private agent: Agent | null = null;
  private run: ActiveRun | null = null;
  private readonly pending = new Map<string, PendingToolCall>();
  /** What each finished tool call made and changed, by the agent's tool call id, until its entry is written. */
  private readonly toolShapes = new Map<string, { pageId: string; created?: string[]; changed?: string[] }>();
  /** The assistant message being streamed, and its text so far. */
  private replyId: string | null = null;
  private replyText = "";
  private replyFlush: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  private readonly host: RoomAssistantHost;
  private readonly audience: AssistantAudience;

  constructor(
    host: RoomAssistantHost,
    audience: AssistantAudience,
  ) {
    this.host = host;
    this.audience = audience;
  }

  get isPrivate(): boolean {
    return this.audience.kind === "private";
  }

  get runId(): string | null {
    return this.run?.id ?? null;
  }

  get requesterUserId(): string | null {
    return this.run?.requesterUserId ?? null;
  }

  /** Whether `userId` sees this conversation. Without a user, only the room's is anyone's. */
  includes(userId: string | undefined): boolean {
    if (this.audience.kind === "room") return true;
    return userId !== undefined && this.audience.members.includes(userId);
  }

  /** A private conversation with nothing running whose members have all left. The room's never is. */
  isAbandoned(isPresent: (userId: string) => boolean): boolean {
    return this.audience.kind === "private" && !this.run && !this.audience.members.some(isPresent);
  }

  hasPendingCall(callId: string): boolean {
    return this.pending.has(callId);
  }

  publicRun(): AssistantRun | null {
    if (!this.run) return null;
    const { id, requesterUserId, requesterName } = this.run;
    return this.isPrivate ? { id, requesterUserId, requesterName, audience: this.audience } : { id, requesterUserId, requesterName };
  }

  prompt(
    model: AssistantModel,
    sender: AssistantSender,
    text: string,
    page: AssistantPageContext,
    context: { said?: string; partnerName: string | null },
  ): string {
    // A private conversation never draws: the board is everyone's.
    const canEdit = !this.isPrivate && this.host.canEdit(sender.userId);
    const run: ActiveRun = {
      id: crypto.randomUUID(),
      requesterUserId: sender.userId,
      requesterName: sender.userName,
      connectionId: sender.connectionId,
      pageId: page.pageId,
      canEdit,
      turns: 0,
    };
    this.run = run;
    this.upsert({
      id: `${run.id}-prompt`,
      kind: "prompt",
      author: sender.userName,
      authorId: sender.userId,
      text,
      lookedAt: lookedAtFromRequest(page, context.said),
    });
    this.deliverRun();

    const agent = this.agentFor(model);
    agent.state.tools = this.toolsFor(run);
    const audience: PromptAudience = !this.isPrivate
      ? { kind: "room" }
      : context.partnerName === null
        ? { kind: "alone" }
        : { kind: "pair", partnerName: context.partnerName };
    void this.execute(agent, run, buildPromptMessage(sender.userName, text, page, { canEdit, audience, said: context.said }));
    return run.id;
  }

  cancel(): void {
    this.agent?.abort();
  }

  connectionEnded(connectionId: string): void {
    for (const call of this.pending.values()) {
      if (call.connectionId === connectionId) call.settle(new Error("The person who asked left the whiteboard."));
    }
  }

  close(): void {
    this.closed = true;
    this.reset();
  }

  reset(): void {
    this.agent?.abort();
    this.agent = null;
    for (const call of this.pending.values()) call.settle(new Error("The conversation was cleared."));
    this.entries = [];
    this.toolShapes.clear();
    this.run = null;
    this.clearReplyFlush();
  }

  toolResult(sender: AssistantSender, result: AssistantToolResult): Reply {
    const call = this.pending.get(result.callId);
    // Only the connection the call went to may answer it.
    if (!call || call.runId !== result.runId || call.connectionId !== sender.connectionId) {
      return Reply.json({ error: "No such tool call" }, 409);
    }
    call.settle(result);
    return Reply.json({ ok: true });
  }

  private deliver(event: AssistantEvent): void {
    if (this.closed) return;
    if (this.audience.kind === "room") this.host.broadcast(event);
    else this.host.sendToUsers(this.audience.members, event);
  }

  private deliverRun(): void {
    this.deliver({
      type: ASSISTANT_EVENTS.RUN,
      run: this.publicRun(),
      ...(this.isPrivate ? { audience: this.audience } : {}),
    });
  }

  private async execute(agent: Agent, run: ActiveRun, message: AgentMessage): Promise<void> {
    const unsubscribe = agent.subscribe((event) => this.onAgentEvent(run, event));
    try {
      await agent.prompt(message);
    } catch (error) {
      logError(`[Assistant ${this.host.whiteboardRoomId}] Run failed:`, error);
      this.notice(run, "Something went wrong. Please try again.");
    } finally {
      unsubscribe();
      if (this.run === run) {
        this.flushReply();
        this.run = null;
        this.deliverRun();
      }
    }
  }

  private agentFor(model: AssistantModel): Agent {
    if (this.agent) return this.agent;
    const agent = new Agent({
      initialState: { systemPrompt: ASSISTANT_SYSTEM_PROMPT, model: model.model },
      streamFn: model.stream,
      // Lets the provider cache this conversation's prompt between turns.
      sessionId: crypto.randomUUID(),
      transformContext: async (messages) => pruneContext(messages),
      finishTurn: () => {
        // A cleared conversation's agent may still be unwinding while the
        // next one runs; it must not count against, or speak in, that run.
        const run = this.run;
        if (this.agent !== agent || !run) return { action: "end" };
        run.turns += 1;
        if (run.turns < MAX_TURNS_PER_RUN) return undefined;
        this.notice(run, "Stopped: that took more steps than allowed.");
        return { action: "end" };
      },
    });
    this.agent = agent;
    return agent;
  }

  // ── agent events → entries ─────────────────────────────────────────────────

  private onAgentEvent(run: ActiveRun, event: AgentEvent): void {
    if (this.run !== run) return;
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") {
          this.replyId = `${run.id}-${crypto.randomUUID()}`;
          this.replyText = "";
        }
        return;
      case "message_update":
        if (event.message.role !== "assistant") return;
        this.replyText = assistantText(event.message);
        this.scheduleReplyFlush();
        return;
      case "message_end": {
        if (event.message.role !== "assistant") return;
        this.replyText = assistantText(event.message);
        this.flushReply();
        this.replyId = null;
        const failure = failureNotice(event.message);
        if (failure) this.notice(run, failure.notice);
        if (failure?.log) {
          logError(`[Assistant ${this.host.whiteboardRoomId}] Model error: ${failure.log}`);
        }
        return;
      }
      case "tool_execution_start":
        this.upsert({
          id: `${run.id}-${event.toolCallId}`,
          kind: "tool",
          tool: event.toolName as CanvasToolName,
          label: toolLabel(event.toolName, event.args),
          status: "running",
        });
        return;
      case "tool_execution_end": {
        const id = `${run.id}-${event.toolCallId}`;
        const entry = this.entries.find((candidate) => candidate.id === id);
        if (entry?.kind === "tool") {
          const { id: entryId, tool, label } = entry;
          const shapes = this.toolShapes.get(event.toolCallId);
          this.toolShapes.delete(event.toolCallId);
          this.upsert({
            id: entryId,
            kind: "tool",
            tool,
            label,
            status: event.isError ? "failed" : "done",
            ...(shapes && (shapes.created?.length || shapes.changed?.length) ? shapes : {}),
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private scheduleReplyFlush(): void {
    if (this.replyFlush) return;
    this.replyFlush = setTimeout(() => {
      this.replyFlush = null;
      this.flushReply(false);
    }, REPLY_FLUSH_MS);
  }

  private clearReplyFlush(): void {
    if (!this.replyFlush) return;
    clearTimeout(this.replyFlush);
    this.replyFlush = null;
  }

  private flushReply(done = true): void {
    if (done) this.clearReplyFlush();
    if (!this.replyId || !this.replyText.trim()) return;
    this.upsert({ id: this.replyId, kind: "reply", text: this.replyText, done });
  }

  private notice(run: ActiveRun, text: string): void {
    this.upsert({ id: `${run.id}-${crypto.randomUUID()}`, kind: "notice", text });
  }

  private upsert(update: NewEntry): void {
    if (this.closed) return;
    const index = this.entries.findIndex((candidate) => candidate.id === update.id);
    // An entry keeps the time it was first recorded, however often it changes,
    // and says whose it is when it is not the room's.
    const at = index === -1 ? Date.now() : this.entries[index].at;
    const entry: AssistantEntry = this.isPrivate ? { ...update, at, audience: this.audience } : { ...update, at };
    if (index === -1) {
      this.entries.push(entry);
      if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    } else {
      this.entries[index] = entry;
    }
    this.deliver({ type: ASSISTANT_EVENTS.ENTRY, entry });
  }

  // ── canvas tools ───────────────────────────────────────────────────────────

  /** The tools for one run, bound to it: a call always goes to that run's requester. */
  private toolsFor(run: ActiveRun): AgentTool[] {
    return (Object.keys(CANVAS_TOOLS) as CanvasToolName[])
      .filter((name) => run.canEdit || !CANVAS_TOOLS[name].edits)
      .map((name) => ({
        name,
        label: CANVAS_TOOLS[name].label,
        description: CANVAS_TOOLS[name].description,
        parameters: toolParameters(name),
        // One page, one browser: calls apply in the order the model made them.
        executionMode: "sequential",
        execute: (toolCallId, args, signal) => this.callRequester(run, name, toolCallId, args, signal),
      }));
  }

  private async callRequester(
    run: ActiveRun,
    tool: CanvasToolName,
    toolCallId: string,
    args: unknown,
    signal: AbortSignal | undefined,
  ): Promise<AgentToolResult<undefined>> {
    if (this.run !== run) return failed("Stopped.");
    if (CANVAS_TOOLS[tool].edits && (!run.canEdit || !this.host.canEdit(run.requesterUserId))) {
      return failed(`${run.requesterName} can no longer edit this whiteboard.`);
    }

    const callId = `${run.id.slice(0, 8)}-${toolCallId}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
    const result = await new Promise<AssistantToolResult | Error>((resolve) => {
      const timer = setTimeout(() => settle(new Error("The requester's browser did not answer in time.")), TOOL_CALL_TIMEOUT_MS);
      const onAbort = () => settle(new Error("Stopped."));
      const settle = (value: AssistantToolResult | Error) => {
        if (!this.pending.has(callId)) return;
        this.pending.delete(callId);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      this.pending.set(callId, { runId: run.id, connectionId: run.connectionId, settle });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) return onAbort();

      const sent = this.host.sendToConnection(run.connectionId, {
        type: ASSISTANT_EVENTS.TOOL_CALL,
        runId: run.id,
        callId,
        pageId: run.pageId,
        tool,
        args,
      });
      if (sent === 0) settle(new Error(`${run.requesterName} is no longer connected.`));
    });

    if (result instanceof Error) return failed(result.message);
    if (result.shapes) this.toolShapes.set(toolCallId, { pageId: run.pageId, ...result.shapes });
    const content: (TextContent | ImageContent)[] = [{ type: "text", text: result.text }];
    if (result.screenshot) content.push(imageContent(result.screenshot));
    return { content, details: undefined, isError: !result.ok };
  }
}

const toolParameterCache = new Map<CanvasToolName, AgentTool["parameters"]>();

function toolParameters(name: CanvasToolName): AgentTool["parameters"] {
  let parameters = toolParameterCache.get(name);
  if (!parameters) {
    // pi validates arguments against plain JSON Schema; the browser re-checks
    // them against the same Valibot schema before touching the board.
    const { $schema: _dialect, ...schema } = toJsonSchema(CANVAS_TOOLS[name].args, { errorMode: "ignore" });
    parameters = withAnyOf(schema) as AgentTool["parameters"];
    toolParameterCache.set(name, parameters);
  }
  return parameters;
}

/**
 * Valibot writes a variant as `oneOf`. Its options are told apart by `_type`,
 * so `anyOf` means the same, and it is the form every provider's function
 * calling accepts.
 */
function withAnyOf(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withAnyOf);
  if (typeof schema !== "object" || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [key === "oneOf" ? "anyOf" : key, withAnyOf(value)]),
  );
}

function failed(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

function assistantText(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function failureNotice(message: AgentMessage): { notice: string; log?: string } | null {
  if (message.role !== "assistant") return null;
  const { stopReason, errorMessage } = message;
  if (stopReason === "aborted") return { notice: "Stopped." };
  if (stopReason === "error") {
    // Provider errors can carry request diagnostics; they go to the log only.
    return { notice: "The assistant could not answer. Please try again.", log: errorMessage ?? "unknown error" };
  }
  if (stopReason === "length") return { notice: "The answer was cut off because it ran too long." };
  return null;
}

function toolLabel(tool: string, args: unknown): string {
  const base = tool in CANVAS_TOOLS ? CANVAS_TOOLS[tool as CanvasToolName].label : tool;
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const count = [record.shapes, record.updates, record.shapeIds].find(Array.isArray)?.length;
  if (count === undefined) return base;
  return `${base} ${count} shape${count === 1 ? "" : "s"}`;
}

/**
 * Keep the model's context bounded: only the newest screenshots stay, and the
 * oldest exchanges are dropped whole, cutting at a user message so a tool call
 * is never separated from its result.
 */
export function pruneContext(messages: AgentMessage[]): AgentMessage[] {
  let kept = messages;
  if (kept.length > MAX_MESSAGES_IN_CONTEXT) {
    const firstAllowed = kept.length - MAX_MESSAGES_IN_CONTEXT;
    const cut = kept.findIndex((message, index) => index >= firstAllowed && message.role === "user");
    if (cut > 0) kept = kept.slice(cut);
  }

  let images = 0;
  const pruned = [...kept];
  for (let index = pruned.length - 1; index >= 0; index--) {
    const message = pruned[index];
    if ((message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") continue;
    if (!message.content.some((part) => part.type === "image")) continue;
    if (images < MAX_IMAGES_IN_CONTEXT) {
      images += 1;
      continue;
    }
    pruned[index] = {
      ...message,
      content: message.content.map((part) =>
        part.type === "image" ? { type: "text" as const, text: "[an earlier screenshot, no longer shown]" } : part,
      ),
    } as AgentMessage;
  }
  return pruned;
}

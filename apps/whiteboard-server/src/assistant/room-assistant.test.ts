import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import {
  ASSISTANT_EVENTS,
  type AssistantEvent,
  type AssistantPageContext,
} from "@orbmeet/whiteboard-core/assistant";
import { pruneContext, RoomAssistant, type AssistantSender } from "./room-assistant.ts";

const PAGE: AssistantPageContext = {
  pageId: "shape:page-1",
  pageNumber: 1,
  pageCount: 2,
  width: 1920,
  height: 1080,
  shapes: [],
  selectedShapeIds: [],
};

const alice: AssistantSender = { userId: "alice", userName: "Alice", connectionId: "conn-alice" };
const bob: AssistantSender = { userId: "bob", userName: "Bob", connectionId: "conn-bob" };
const carol: AssistantSender = { userId: "carol", userName: "Carol", connectionId: "conn-carol" };
const NAMES: Record<string, string> = { alice: "Alice", bob: "Bob", carol: "Carol" };

type ToolCallEvent = Extract<AssistantEvent, { type: typeof ASSISTANT_EVENTS.TOOL_CALL }>;

function setup(options: { responses: FauxResponseStep[]; editors?: string[]; managers?: string[]; connected?: string[] }) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(options.responses);
  const contexts: TranscriptContext[] = [];
  const broadcasts: AssistantEvent[] = [];
  /** What each person received privately, by user id. */
  const privately = new Map<string, AssistantEvent[]>();
  const toolCalls: { connectionId: string; event: ToolCallEvent }[] = [];
  const connected = new Set(options.connected ?? [alice.connectionId, bob.connectionId]);
  const editors = new Set(options.editors ?? [alice.userId]);
  const managers = new Set(options.managers ?? []);

  const assistant = new RoomAssistant(
    {
      whiteboardRoomId: "meet-test",
      broadcast: (event) => broadcasts.push(event),
      sendToUsers: (userIds, event) => {
        for (const userId of userIds) privately.set(userId, [...(privately.get(userId) ?? []), event]);
      },
      presentName: (userId) => (connected.has(`conn-${userId}`) ? (NAMES[userId] ?? null) : null),
      sendToConnection: (connectionId, event) => {
        if (!connected.has(connectionId)) return 0;
        toolCalls.push({ connectionId, event: event as ToolCallEvent });
        return 1;
      },
      canEdit: (userId) => editors.has(userId),
      canManage: (userId) => managers.has(userId),
    },
    {
      model: faux.getModel(),
      stream: (model, context, streamOptions) => {
        contexts.push(context);
        return models.streamSimple(model, context, streamOptions);
      },
    },
  );
  return { assistant, contexts, broadcasts, privately, toolCalls, editors, connected };
}

let open: RoomAssistant[] = [];
afterEach(() => {
  for (const assistant of open) assistant.close();
  open = [];
});

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function runEnded(broadcasts: AssistantEvent[]): boolean {
  return broadcasts.some((event) => event.type === ASSISTANT_EVENTS.RUN && event.run === null);
}

function prompt(assistant: RoomAssistant, sender: AssistantSender, text = "Draw a box") {
  return assistant.handle(sender, { type: "prompt", text, page: PAGE });
}

describe("RoomAssistant", () => {
  it("runs a canvas tool in the requester's browser and shares the reply with everyone", async () => {
    const t = setup({
      responses: [
        fauxAssistantMessage(
          [fauxToolCall("create_shapes", { shapes: [{ _type: "rectangle", shapeId: "box", x: 10, y: 10, w: 200, h: 100 }] })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("I drew a box."),
      ],
    });
    open.push(t.assistant);

    expect(prompt(t.assistant, alice).status).toBe(200);
    await until(() => t.toolCalls.length === 1, "the tool call");

    const [{ connectionId, event }] = t.toolCalls;
    expect(connectionId).toBe(alice.connectionId);
    expect(event).toMatchObject({ tool: "create_shapes", pageId: PAGE.pageId });

    const result = t.assistant.handle(alice, {
      type: "tool-result",
      runId: event.runId,
      callId: event.callId,
      ok: true,
      text: "Created box.",
      shapes: { created: ["box"] },
    });
    expect(result.status).toBe(200);
    await until(() => runEnded(t.broadcasts), "the run to end");

    // The model saw the browser's answer as the tool result.
    const toolResult = t.contexts[1].messages.find((message) => message.role === "toolResult");
    expect(toolResult?.content).toEqual([{ type: "text", text: "Created box." }]);

    const entries = t.assistant.snapshot().entries;
    expect(entries.map((entry) => entry.kind)).toEqual(["prompt", "tool", "reply"]);
    expect(entries[0]).toMatchObject({ kind: "prompt", author: "Alice", authorId: "alice", text: "Draw a box" });
    expect(entries[1]).toMatchObject({
      kind: "tool",
      tool: "create_shapes",
      status: "done",
      label: "Drawing 1 shape",
      pageId: PAGE.pageId,
      created: ["box"],
    });
    expect(entries[2]).toMatchObject({ kind: "reply", text: "I drew a box.", done: true });
    expect(t.assistant.snapshot().run).toBeNull();
  });

  it("stamps each entry with the time it was first recorded, and keeps it through updates", async () => {
    const t = setup({
      responses: [
        fauxAssistantMessage([fauxToolCall("view_page", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("Looked."),
      ],
    });
    open.push(t.assistant);

    const before = Date.now();
    prompt(t.assistant, alice);
    await until(() => t.toolCalls.length === 1, "the tool call");
    const { event } = t.toolCalls[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
    t.assistant.handle(alice, { type: "tool-result", runId: event.runId, callId: event.callId, ok: true, text: "ok" });
    await until(() => runEnded(t.broadcasts), "the run to end");

    const toolEvents = t.broadcasts.flatMap((broadcast) =>
      broadcast.type === ASSISTANT_EVENTS.ENTRY && broadcast.entry.kind === "tool" ? [broadcast.entry] : [],
    );
    expect(toolEvents.map((entry) => entry.kind === "tool" && entry.status)).toEqual(["running", "done"]);
    expect(toolEvents[1].at).toBe(toolEvents[0].at);

    const entries = t.assistant.snapshot().entries;
    for (const entry of entries) expect(entry.at).toBeGreaterThanOrEqual(before);
    const times = entries.map((entry) => entry.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("offers a view-only requester no tools that edit the board", async () => {
    const t = setup({ responses: [fauxAssistantMessage("I can only describe it.")], editors: [] });
    open.push(t.assistant);

    prompt(t.assistant, bob, "What is on this page?");
    await until(() => runEnded(t.broadcasts), "the run to end");

    expect(getCurrentTools(t.contexts[0].messages).map((tool) => tool.name)).toEqual(["view_page"]);
  });

  it("answers one prompt at a time", async () => {
    const t = setup({
      responses: [fauxAssistantMessage([fauxToolCall("view_page", {})], { stopReason: "toolUse" })],
    });
    open.push(t.assistant);

    prompt(t.assistant, alice);
    await until(() => t.toolCalls.length === 1, "the tool call");
    expect(prompt(t.assistant, bob).status).toBe(409);
  });

  it("accepts a tool result only from the connection the call went to", async () => {
    const t = setup({
      responses: [
        fauxAssistantMessage([fauxToolCall("view_page", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("Done."),
      ],
    });
    open.push(t.assistant);

    prompt(t.assistant, alice);
    await until(() => t.toolCalls.length === 1, "the tool call");
    const { event } = t.toolCalls[0];
    const forged = { type: "tool-result" as const, runId: event.runId, callId: event.callId, ok: true, text: "forged" };

    expect(t.assistant.handle(bob, forged).status).toBe(409);
    expect(t.assistant.handle({ ...alice, connectionId: "conn-alice-other-tab" }, forged).status).toBe(409);
    expect(t.assistant.handle(alice, { ...forged, text: "real" }).status).toBe(200);
    await until(() => runEnded(t.broadcasts), "the run to end");
  });

  it("fails the call when the requester leaves, and the model carries on", async () => {
    const t = setup({
      responses: [
        fauxAssistantMessage([fauxToolCall("view_page", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("You left before I could look."),
      ],
    });
    open.push(t.assistant);

    prompt(t.assistant, alice);
    await until(() => t.toolCalls.length === 1, "the tool call");
    t.assistant.connectionEnded(alice.connectionId);
    await until(() => runEnded(t.broadcasts), "the run to end");

    const toolResult = t.contexts[1].messages.find((message) => message.role === "toolResult");
    expect(toolResult).toMatchObject({ isError: true });
    expect(t.assistant.snapshot().entries.find((entry) => entry.kind === "tool")).toMatchObject({ status: "failed" });
  });

  it("refuses an edit when the requester lost edit access mid-run", async () => {
    const t = setup({
      responses: [
        fauxAssistantMessage([fauxToolCall("delete_shapes", { shapeIds: ["box"] })], { stopReason: "toolUse" }),
        fauxAssistantMessage("I can no longer edit."),
      ],
      editors: [alice.userId],
    });
    open.push(t.assistant);

    // Edit access chooses the tools when the run starts and is checked again
    // at every call; revoke it in between.
    prompt(t.assistant, alice);
    t.editors.delete(alice.userId);
    await until(() => runEnded(t.broadcasts), "the run to end");

    expect(t.toolCalls).toHaveLength(0);
    const toolResult = t.contexts[1].messages.find((message) => message.role === "toolResult");
    expect(toolResult).toMatchObject({ isError: true, content: [{ type: "text", text: "Alice can no longer edit this whiteboard." }] });
  });

  it("lets only a whiteboard manager clear the conversation", async () => {
    const t = setup({ responses: [fauxAssistantMessage("Hello.")], managers: [bob.userId] });
    open.push(t.assistant);
    prompt(t.assistant, alice, "Hi");
    await until(() => runEnded(t.broadcasts), "the run to end");

    expect(t.assistant.handle(alice, { type: "clear" }).status).toBe(403);
    expect(t.assistant.snapshot().entries).not.toHaveLength(0);

    expect(t.assistant.handle(bob, { type: "clear" }).status).toBe(200);
    expect(t.assistant.snapshot().entries).toHaveLength(0);
    expect(t.broadcasts.at(-1)).toMatchObject({ type: ASSISTANT_EVENTS.SNAPSHOT, snapshot: { entries: [] } });
  });

  it("starts clean after a clear that interrupts a run", async () => {
    const t = setup({
      responses: [
        fauxAssistantMessage([fauxToolCall("view_page", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("Hello Bob."),
      ],
      managers: [bob.userId],
    });
    open.push(t.assistant);

    prompt(t.assistant, alice);
    await until(() => t.toolCalls.length === 1, "Alice's tool call");
    expect(t.assistant.handle(bob, { type: "clear" }).status).toBe(200);
    expect(prompt(t.assistant, bob, "Hi").status).toBe(200);
    await until(() => t.assistant.snapshot().run === null, "Bob's run to end");

    // Nothing from Alice's interrupted run reached Bob's conversation or browser.
    expect(t.toolCalls.map((call) => call.connectionId)).toEqual([alice.connectionId]);
    expect(t.assistant.snapshot().entries.map((entry) => entry.kind === "reply" ? entry.text : entry.kind)).toEqual([
      "prompt",
      "Hello Bob.",
    ]);
  });

  it("is unavailable without a model", () => {
    const assistant = new RoomAssistant(
      {
        whiteboardRoomId: "meet-test",
        broadcast: () => {},
        sendToUsers: () => {},
        presentName: () => null,
        sendToConnection: () => 0,
        canEdit: () => true,
        canManage: () => true,
      },
      null,
    );
    open.push(assistant);
    expect(assistant.snapshot().available).toBe(false);
    expect(prompt(assistant, alice).status).toBe(503);
  });
});

describe("RoomAssistant in private", () => {
  function promptText(context: TranscriptContext): string {
    const message = context.messages.find((candidate) => candidate.role === "user");
    const part = Array.isArray(message?.content) ? message.content[0] : undefined;
    return part?.type === "text" ? part.text : "";
  }

  function privateRunEnded(events: AssistantEvent[] | undefined): boolean {
    return (events ?? []).some((event) => event.type === ASSISTANT_EVENTS.RUN && event.run === null);
  }

  it("answers a question asked privately to the asker alone", async () => {
    const t = setup({ responses: [fauxAssistantMessage("Only for you.")] });
    open.push(t.assistant);

    const response = t.assistant.handle(alice, {
      type: "prompt",
      text: "What should I cover next?",
      page: PAGE,
      audience: { kind: "private" },
    });
    expect(response.status).toBe(200);
    await until(() => privateRunEnded(t.privately.get(alice.userId)), "the private run to end");

    // Nothing reached the room or anyone else.
    expect(t.broadcasts).toEqual([]);
    expect([...t.privately.keys()]).toEqual([alice.userId]);
    const audience = { kind: "private", members: ["alice"] };
    expect(t.privately.get(alice.userId)?.find((event) => event.type === ASSISTANT_EVENTS.ENTRY)).toMatchObject({
      entry: { kind: "prompt", audience },
    });

    expect(t.assistant.snapshot(alice.userId).entries.map((entry) => entry.kind)).toEqual(["prompt", "reply"]);
    expect(t.assistant.snapshot(bob.userId).entries).toEqual([]);
    expect(t.assistant.snapshot().entries).toEqual([]);

    // It may look at the board but not draw on it, even for an editor.
    expect(getCurrentTools(t.contexts[0].messages).map((tool) => tool.name)).toEqual(["view_page"]);
    expect(promptText(t.contexts[0])).toContain("only Alice sees this question and your answer");
  });

  it("answers two people's private question to the two of them", async () => {
    const t = setup({ responses: [fauxAssistantMessage("For you two.")], connected: ["conn-alice", "conn-bob", "conn-carol"] });
    open.push(t.assistant);

    const ask = { type: "prompt" as const, text: "Is it saved?", page: PAGE, audience: { kind: "private" as const, with: "bob" } };
    expect(t.assistant.handle(alice, ask).status).toBe(200);
    await until(() => privateRunEnded(t.privately.get(bob.userId)), "the private run to end");

    expect(t.broadcasts).toEqual([]);
    expect([...t.privately.keys()].sort()).toEqual(["alice", "bob"]);
    expect(t.assistant.snapshot(bob.userId).entries.map((entry) => entry.kind)).toEqual(["prompt", "reply"]);
    expect(t.assistant.snapshot(carol.userId).entries).toEqual([]);
    expect(promptText(t.contexts[0])).toContain("private between Alice and Bob");
  });

  it("refuses a private question with someone who is not on the board", () => {
    const t = setup({ responses: [fauxAssistantMessage("Hi.")] });
    open.push(t.assistant);
    const ask = { type: "prompt" as const, text: "Hi", page: PAGE, audience: { kind: "private" as const, with: "carol" } };
    expect(t.assistant.handle(alice, ask).status).toBe(409);
    expect(t.privately.size).toBe(0);
  });

  it("runs a private conversation while the room's is busy, and only its members can stop it", async () => {
    const t = setup({
      responses: [
        fauxAssistantMessage([fauxToolCall("view_page", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("view_page", {})], { stopReason: "toolUse" }),
      ],
    });
    open.push(t.assistant);

    prompt(t.assistant, alice);
    await until(() => t.toolCalls.length === 1, "the room's tool call");
    const response = t.assistant.handle(bob, { type: "prompt", text: "Quick one", page: PAGE, audience: { kind: "private" } });
    expect(response.status).toBe(200);
    const { runId } = response.json as { runId: string };

    expect(t.assistant.handle(alice, { type: "cancel", runId }).status).toBe(403);
    expect(t.assistant.handle(bob, { type: "cancel", runId }).status).toBe(200);
    await until(() => privateRunEnded(t.privately.get(bob.userId)), "the private run to end");
    expect(t.assistant.snapshot().run).not.toBeNull();
  });

  it("forgets a private conversation once everyone in it has left", async () => {
    const t = setup({ responses: [fauxAssistantMessage("Only for you."), fauxAssistantMessage("And you.")] });
    open.push(t.assistant);

    const ask = { type: "prompt" as const, text: "Hi", page: PAGE, audience: { kind: "private" as const } };
    expect(t.assistant.handle(alice, ask).status).toBe(200);
    await until(() => privateRunEnded(t.privately.get(alice.userId)), "alice's private run to end");
    expect(t.assistant.snapshot(alice.userId).entries).not.toEqual([]);

    // Alice leaves; the next conversation started reclaims hers.
    t.connected.delete(alice.connectionId);
    expect(t.assistant.handle(bob, ask).status).toBe(200);
    await until(() => privateRunEnded(t.privately.get(bob.userId)), "bob's private run to end");

    expect(t.assistant.snapshot(alice.userId).entries).toEqual([]);
    expect(t.assistant.snapshot(bob.userId).entries.map((entry) => entry.kind)).toEqual(["prompt", "reply"]);
  });

  it("keeps a private conversation while one of its members is still here", async () => {
    const t = setup({
      responses: [fauxAssistantMessage("For you two."), fauxAssistantMessage("Hello.")],
      connected: ["conn-alice", "conn-bob", "conn-carol"],
    });
    open.push(t.assistant);

    const pair = { type: "prompt" as const, text: "Is it saved?", page: PAGE, audience: { kind: "private" as const, with: "bob" } };
    expect(t.assistant.handle(alice, pair).status).toBe(200);
    await until(() => privateRunEnded(t.privately.get(bob.userId)), "the pair's run to end");

    t.connected.delete(alice.connectionId);
    const alone = { type: "prompt" as const, text: "Hi", page: PAGE, audience: { kind: "private" as const } };
    expect(t.assistant.handle(carol, alone).status).toBe(200);
    await until(() => privateRunEnded(t.privately.get(carol.userId)), "carol's run to end");

    expect(t.assistant.snapshot(bob.userId).entries.map((entry) => entry.kind)).toEqual(["prompt", "reply"]);
  });

  it("gives the model what was said lately", async () => {
    const t = setup({ responses: [fauxAssistantMessage("Maya split it into two cases.")] });
    open.push(t.assistant);
    t.assistant.handle(alice, {
      type: "prompt",
      text: "Catch me up",
      page: PAGE,
      audience: { kind: "private" },
      said: "Maya Kim: so we split it into two cases",
    });
    await until(() => privateRunEnded(t.privately.get(alice.userId)), "the private run to end");
    expect(promptText(t.contexts[0])).toContain("What was said in the meeting lately:\nMaya Kim: so we split it into two cases");
  });

  it("keeps what went with a question on it, for its answer to show", async () => {
    const t = setup({ responses: [fauxAssistantMessage("We are on the second case.")] });
    open.push(t.assistant);
    t.assistant.handle(alice, {
      type: "prompt",
      text: "Where are we?",
      page: { ...PAGE, following: { presenterName: "Maya Kim", pageNumber: PAGE.pageNumber } },
      audience: { kind: "private" },
      said: "Maya Kim: now the second case",
    });
    await until(() => privateRunEnded(t.privately.get(alice.userId)), "the private run to end");
    expect(t.privately.get(alice.userId)).toContainEqual(
      expect.objectContaining({
        type: ASSISTANT_EVENTS.ENTRY,
        entry: expect.objectContaining({
          kind: "prompt",
          lookedAt: { pageNumber: PAGE.pageNumber, pageCount: PAGE.pageCount, following: "Maya Kim", said: true },
        }),
      }),
    );
  });
});

describe("pruneContext", () => {
  const image = { type: "image" as const, mimeType: "image/jpeg", data: "x" };
  const user = (text: string, withImage = false): AgentMessage => ({
    role: "user",
    content: withImage ? [{ type: "text", text }, image] : [{ type: "text", text }],
    timestamp: 0,
  });

  it("keeps only the newest screenshots", () => {
    const pruned = pruneContext([user("1", true), user("2", true), user("3", true)]);
    const imageCounts = pruned.map((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === "image").length : 0,
    );
    expect(imageCounts).toEqual([0, 1, 1]);
  });

  it("drops the oldest exchanges at a user message", () => {
    const messages = Array.from({ length: 100 }, (_, index) => user(String(index)));
    const pruned = pruneContext(messages);
    expect(pruned.length).toBeLessThanOrEqual(80);
    expect(pruned[0].role).toBe("user");
    expect(pruned.at(-1)).toBe(messages.at(-1));
  });
});

describe("tool parameters", () => {
  it("are plain JSON Schema the model can read", async () => {
    const t = setup({ responses: [fauxAssistantMessage(fauxText("ok"))] });
    open.push(t.assistant);
    prompt(t.assistant, alice);
    await until(() => runEnded(t.broadcasts), "the run to end");

    const create = getCurrentTools(t.contexts[0].messages).find((tool) => tool.name === "create_shapes");
    expect(create?.parameters).toMatchObject({
      type: "object",
      required: ["shapes"],
      properties: { shapes: { type: "array", items: { anyOf: expect.any(Array) } } },
    });
    expect(create?.parameters).not.toHaveProperty("$schema");
  });
});

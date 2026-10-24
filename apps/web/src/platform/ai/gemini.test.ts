import { chat } from "@tanstack/ai";
import { describe, expect, it, vi } from "vitest";
import { createGeminiTextAdapter, MAX_SSE_EVENT_LENGTH, splitSseEvents, toGeminiSchema } from "./gemini";

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("createGeminiTextAdapter", () => {
  it("authenticates Gemini Developer API requests with x-goog-api-key", async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      new Response(
        streamFromText('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n'),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createGeminiTextAdapter("gemini-3.5-flash", "test-api-key");

    for await (const _chunk of chat({
      adapter,
      messages: [{ role: "user", content: "Hello" }],
    })) {
      // Drain the stream so the request is issued.
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(
      "/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
    );
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-goog-api-key": "test-api-key",
    });
    expect(init?.headers).not.toHaveProperty("Authorization");
  });

  it("parses streamed Gemini SSE text chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () =>
        new Response(
          streamFromText(
            [
              'data: {"candidates":[{"content":{"parts":[{"text":"Hello "}]} }]}',
              'data: {"candidates":[{"content":{"parts":[{"text":"world"}]}}]}',
              "",
            ].join("\n\n"),
          ),
          { status: 200 },
        ),
      ),
    );

    const adapter = createGeminiTextAdapter("gemini-3.5-flash", "test-api-key");
    const textChunks: string[] = [];

    for await (const chunk of chat({
      adapter,
      messages: [{ role: "user", content: "Hello" }],
    })) {
      if (chunk.type === "TEXT_MESSAGE_CONTENT") {
        textChunks.push(chunk.delta);
      }
    }

    expect(textChunks.join("")).toBe("Hello world");
  });

  it("parses a final Gemini SSE event without a trailing newline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () =>
        new Response(
          streamFromText('data: {"candidates":[{"content":{"parts":[{"text":"tail"}]}}]}'),
          { status: 200 },
        ),
      ),
    );

    const adapter = createGeminiTextAdapter("gemini-3.5-flash", "test-api-key");
    const textChunks: string[] = [];

    for await (const chunk of chat({
      adapter,
      messages: [{ role: "user", content: "Hello" }],
    })) {
      if (chunk.type === "TEXT_MESSAGE_CONTENT") {
        textChunks.push(chunk.delta);
      }
    }

    expect(textChunks.join("")).toBe("tail");
  });

  it("ends the message and emits a run error when Gemini reports a blocked prompt", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () =>
        new Response(
          streamFromText('data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n'),
          { status: 200 },
        ),
      ),
    );

    const adapter = createGeminiTextAdapter("gemini-3.5-flash", "test-api-key");

    const chunks = [];
    for await (const chunk of adapter.chatStream({
        adapter,
        messages: [{ role: "user", content: "Hello" }],
        systemPrompts: [],
        modelOptions: {},
        logger: { request: vi.fn() },
      } as never)) {
      chunks.push(chunk);
    }
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_END",
      "RUN_ERROR",
    ]);
    expect(chunks.at(-1)).toMatchObject({
      message: "Gemini stream failed",
      code: "PROVIDER_STREAM_ERROR",
    });
    // The provider's diagnostics stay in the server log, never in the stream.
    expect(consoleError).toHaveBeenCalledOnce();
    expect(JSON.parse(consoleError.mock.calls[0][0] as string)).toMatchObject({
      level: "error",
      msg: "[gemini-stream] Provider stream failed",
      args: [{ message: "Gemini prompt blocked: SAFETY" }],
    });
    consoleError.mockRestore();
  });

  it("does not finish a stream after its abort signal is set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () =>
        new Response(
          streamFromText('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n'),
          { status: 200 },
        ),
      ),
    );
    const adapter = createGeminiTextAdapter("gemini-3.5-flash", "test-api-key");
    const abortController = new AbortController();
    abortController.abort(new Error("summary cancelled"));

    await expect(async () => {
      for await (const _chunk of adapter.chatStream({
        messages: [{ role: "user", content: "Hello" }],
        systemPrompts: [],
        modelOptions: {},
        abortController,
        logger: { request: vi.fn() },
      } as never)) {
        // Drain the adapter directly so a false RUN_FINISHED is observable.
      }
    }).rejects.toThrow("summary cancelled");
  });

  it("honors the request signal supplied by the chat engine", async () => {
    let seenSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn<FetchMock>((_input, init) => {
      seenSignal = init?.signal;
      return new Promise<Response>(() => undefined);
    }));
    const adapter = createGeminiTextAdapter("gemini-3.5-flash", "test-api-key");
    const abortController = new AbortController();
    const draining = (async () => {
      for await (const _chunk of adapter.chatStream({
        messages: [{ role: "user", content: "Hello" }],
        systemPrompts: [],
        modelOptions: {},
        request: { signal: abortController.signal },
        logger: { request: vi.fn() },
      } as never)) {
        // Drain until cancellation.
      }
    })();
    abortController.abort(new Error("summary cancelled"));
    await expect(draining).rejects.toThrow("summary cancelled");
    expect(seenSignal).toBe(abortController.signal);
  });

  it("cancels and unlocks the Gemini body when the stream consumer leaves early", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
        ));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () => new Response(body, { status: 200 })),
    );
    const adapter = createGeminiTextAdapter("gemini-3.5-flash", "test-api-key");
    const stream = adapter.chatStream({
      messages: [{ role: "user", content: "Hello" }],
      systemPrompts: [],
      modelOptions: {},
      logger: { request: vi.fn() },
    } as never)[Symbol.asyncIterator]();

    await stream.next();
    await stream.next();
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "TEXT_MESSAGE_CONTENT", delta: "partial" },
    });
    await stream.return?.();

    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("does not expose model-controlled text in structured JSON parse errors", async () => {
    const modelText = "SECRET_MODEL_OUTPUT_NOT_JSON";
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () =>
        Response.json({
          candidates: [{ content: { parts: [{ text: modelText }] } }],
        }),
      ),
    );
    const adapter = createGeminiTextAdapter("gemini-3.5-flash", "test-api-key");

    const result = adapter.structuredOutput({
      chatOptions: {
        messages: [{ role: "user", content: "Hello" }],
        systemPrompts: [],
        modelOptions: {},
        logger: { request: vi.fn() },
      },
      outputSchema: { type: "object" },
    } as never);
    await expect(result).rejects.toThrow("Gemini returned invalid structured JSON");
    await expect(result).rejects.not.toThrow(modelText);
  });
});

describe("splitSseEvents bounds", () => {
  it("refuses a partial event that never reaches a boundary", () => {
    // The remainder is accumulated across reads by both stream consumers, so an
    // upstream that never sends `\n\n` grew it for the life of the stream.
    expect(() => splitSseEvents("x".repeat(MAX_SSE_EVENT_LENGTH + 1))).toThrow(
      /without an event boundary/,
    );
  });

  it("still returns a complete event of the same size", () => {
    const payload = "x".repeat(MAX_SSE_EVENT_LENGTH);
    const { events, remainder } = splitSseEvents(`${payload}\n\n`);
    expect(events).toEqual([payload]);
    expect(remainder).toBe("");
  });
});

describe("toGeminiSchema", () => {
  it("turns a const into a typed one-value enum", () => {
    expect(toGeminiSchema({ const: "message" })).toEqual({ enum: ["message"], type: "string" });
    expect(toGeminiSchema({ type: "string", const: "message" })).toEqual({ type: "string", enum: ["message"] });
  });
});

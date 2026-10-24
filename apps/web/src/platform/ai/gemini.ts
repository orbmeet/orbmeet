import { BaseTextAdapter, type StructuredOutputOptions, type StructuredOutputResult } from "@tanstack/ai/adapters";
import type { JSONSchema, ModelMessage, StreamChunk, TextOptions } from "@tanstack/ai";
import { extractSseData } from "@orbmeet/primitives";
import { isRecord } from "@orbmeet/primitives";
import { logError } from "@/lib/logger";

type GeminiProviderOptions = Record<string, unknown>;

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
    finishReason?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
  error?: {
    message?: string;
  };
  usageMetadata?: {
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

class GeminiFetchTextAdapter extends BaseTextAdapter<
  string,
  GeminiProviderOptions,
  readonly ["text", "image"],
  {
    text: Record<string, never>;
    image: Record<string, never>;
    audio: Record<string, never>;
    video: Record<string, never>;
    document: Record<string, never>;
  },
  readonly []
> {
  readonly name = "gemini-fetch";

  async *chatStream(options: TextOptions<GeminiProviderOptions>): AsyncIterable<StreamChunk> {
    // Streaming only emits text deltas; it never applies a response schema.
    // `structuredOutput()` is the schema-constrained path. Fail loudly rather
    // than silently dropping a schema a caller threaded through `chat({ stream })`.
    if (options.outputSchema) {
      throw new Error(
        "GeminiFetchTextAdapter.chatStream does not honor outputSchema; use a non-streaming structuredOutput() call for schema-constrained generation.",
      );
    }

    const runId = options.runId ?? crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const startedAt = Date.now();

    yield { type: "RUN_STARTED", threadId: options.threadId, runId, timestamp: startedAt } as StreamChunk;
    yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant", timestamp: startedAt } as StreamChunk;

    try {
      const response = await this.fetchGemini("streamGenerateContent", options, {
        stream: true,
      });

      if (!response.body) throw new Error("Gemini stream did not return a response body");

      const decoder = new TextDecoder();
      let buffer = "";

      const reader = response.body.getReader();
      const signal = requestSignal(options);
      let reachedEnd = false;
      try {
        while (true) {
          const { done, value: chunk } = await withAbort(reader.read(), signal);
          if (done) {
            reachedEnd = true;
            break;
          }
          if (signal?.aborted) break;
          buffer += decoder.decode(chunk, { stream: true });

          const { events, remainder } = splitSseEvents(buffer);
          buffer = remainder;

          for (const event of events) {
            const parsed = parseGeminiSseEvent(event);
            if (!parsed) continue;
            validateGeminiChunk(parsed);
            const text = extractGeminiText(parsed);
            if (!text) continue;
            yield {
              type: "TEXT_MESSAGE_CONTENT",
              messageId,
              delta: text,
              timestamp: Date.now(),
            } as StreamChunk;
          }
        }
      } finally {
        if (!reachedEnd) {
          await reader.cancel().catch(() => undefined);
        }
        reader.releaseLock();
      }

      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Gemini request aborted", "AbortError");
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        const parsed = parseGeminiSseEvent(buffer);
        if (parsed) {
          validateGeminiChunk(parsed);
          const text = extractGeminiText(parsed);
          if (text) {
            yield {
              type: "TEXT_MESSAGE_CONTENT",
              messageId,
              delta: text,
              timestamp: Date.now(),
            } as StreamChunk;
          }
        }
      }

      yield { type: "TEXT_MESSAGE_END", messageId, timestamp: Date.now() } as StreamChunk;
      yield {
        type: "RUN_FINISHED",
        threadId: options.threadId,
        runId,
        timestamp: Date.now(),
      } as StreamChunk;
    } catch (error) {
      if (requestSignal(options)?.aborted) throw error;
      // Provider response text can contain sensitive request diagnostics, so
      // retain it in server logs without forwarding it to stream consumers.
      logError("[gemini-stream] Provider stream failed", error);
      yield { type: "TEXT_MESSAGE_END", messageId, timestamp: Date.now() } as StreamChunk;
      yield {
        type: "RUN_ERROR",
        message: "Gemini stream failed",
        code: "PROVIDER_STREAM_ERROR",
        timestamp: Date.now(),
      } as StreamChunk;
    }
  }

  async structuredOutput(
    options: StructuredOutputOptions<GeminiProviderOptions>,
  ): Promise<StructuredOutputResult<unknown>> {
    const response = await this.fetchGemini("generateContent", options.chatOptions, {
      outputSchema: options.outputSchema,
    });
    const parsedJson: unknown = await response.json();
    if (!isGeminiResponse(parsedJson)) {
      throw new Error("Gemini returned an unexpected response shape");
    }
    const parsed = parsedJson;
    validateGeminiChunk(parsed);

    const rawText = extractGeminiText(parsed);
    if (!rawText) throw new Error("Gemini returned an empty structured response");

    let data: unknown;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error("Gemini returned invalid structured JSON");
    }

    return { rawText, data };
  }

  private async fetchGemini(
    action: "generateContent" | "streamGenerateContent",
    options: TextOptions<GeminiProviderOptions>,
    extra: { stream?: boolean; outputSchema?: JSONSchema },
  ): Promise<Response> {
    const apiKey = this.config.apiKey;
    if (!apiKey) throw new Error("Missing Gemini API key");

    const url = new URL(`${GEMINI_API_BASE}/models/${encodeURIComponent(this.model)}:${action}`);
    if (extra.stream) url.searchParams.set("alt", "sse");

    const body = buildGeminiRequestBody(options, extra.outputSchema);
    options.logger.request(
      `activity=gemini-fetch action=${action} model=${this.model}`,
      {
        stream: extra.stream === true,
        messageCount: options.messages.length,
      },
    );
    const signal = requestSignal(options);
    const response = await withAbort(fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
        ...this.config.headers,
      },
      body: JSON.stringify(body),
      signal,
    }), signal);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Gemini request failed (${response.status}): ${text || response.statusText}`);
    }

    return response;
  }
}

function requestSignal(options: TextOptions<GeminiProviderOptions>): AbortSignal | undefined {
  const requestSignal = options.request && "signal" in options.request
    ? options.request.signal
    : undefined;
  return requestSignal ?? options.abortController?.signal;
}

function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Gemini request aborted", "AbortError");
}

export function createGeminiTextAdapter(model: string, apiKey: string) {
  return new GeminiFetchTextAdapter({ apiKey }, model);
}

function buildGeminiRequestBody(
  options: TextOptions<GeminiProviderOptions>,
  outputSchema?: JSONSchema,
) {
  const { maxTokens, ...restModelOptions } = (options.modelOptions ?? {}) as Record<string, unknown>;
  const generationConfig: Record<string, unknown> = {
    ...restModelOptions,
    ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
  };

  if (outputSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = toGeminiSchema(outputSchema);
  }

  return {
    ...(options.systemPrompts?.length
      ? { systemInstruction: { parts: options.systemPrompts.map((text) => ({ text })) } }
      : {}),
    contents: mergeConsecutiveGeminiContents((options.messages ?? []).map(toGeminiContent)),
    generationConfig: removeUndefined(generationConfig),
  };
}

function toGeminiContent(message: ModelMessage): GeminiContent {
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: toGeminiParts(message.content),
  };
}

function toGeminiParts(content: ModelMessage["content"]): GeminiPart[] {
  if (typeof content === "string") return [{ text: content }];
  if (!content) return [{ text: "" }];

  return content.flatMap((part): GeminiPart[] => {
    if (part.type === "text") return [{ text: part.content }];
    if (part.type === "image") {
      if (part.source.type !== "data") {
        throw new Error("Gemini fetch adapter only supports inline image data");
      }
      return [{
        inlineData: {
          mimeType: part.source.mimeType,
          data: part.source.value,
        },
      }];
    }
    return [];
  });
}

function mergeConsecutiveGeminiContents(contents: GeminiContent[]): GeminiContent[] {
  const merged: GeminiContent[] = [];
  for (const content of contents) {
    const previous = merged.at(-1);
    if (previous?.role === content.role) {
      previous.parts.push(...content.parts);
    } else {
      merged.push({ role: content.role, parts: [...content.parts] });
    }
  }
  return merged;
}

/**
 * Concatenate the visible text of a Gemini response, skipping `thought` parts
 * (internal reasoning from Gemini 3.x thinking models).
 */
function extractGeminiText(response: GeminiResponse): string {
  return response.candidates
    ?.flatMap((candidate) => candidate.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("") ?? "";
}

/**
 * The largest partial SSE event this will hold while waiting for its boundary.
 *
 * The remainder is whatever has arrived without a `\n\n` yet, so an upstream
 * that never sends one — a broken proxy, a truncated framing, a hostile
 * response — grew it for the whole life of the stream with nothing else in the
 * pipeline bounding it. Comfortably above any real Gemini event.
 */
export const MAX_SSE_EVENT_LENGTH = 1024 * 1024;

/**
 * Split a buffer of SSE bytes at event boundaries (`\n\n`). Returns the
 * complete events and the unconsumed trailing remainder. Normalizes CRLF.
 *
 * Throws if the remainder grows past {@link MAX_SSE_EVENT_LENGTH}: the caller
 * is accumulating it across reads, so refusing here is what bounds it.
 */
export function splitSseEvents(buffer: string): { events: string[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const events: string[] = [];
  let start = 0;
  let boundary = normalized.indexOf("\n\n");

  while (boundary >= 0) {
    events.push(normalized.slice(start, boundary));
    start = boundary + 2;
    boundary = normalized.indexOf("\n\n", start);
  }

  const remainder = normalized.slice(start);
  if (remainder.length > MAX_SSE_EVENT_LENGTH) {
    throw new Error(
      `SSE event exceeded ${MAX_SSE_EVENT_LENGTH} characters without an event boundary`,
    );
  }

  return { events, remainder };
}

/**
 * Parse a single SSE event into a {@link GeminiResponse}. Joins multi-line
 * `data:` continuations per the SSE spec. Returns undefined for empty events,
 * `[DONE]` sentinels, or unparseable payloads.
 */
function parseGeminiSseEvent(event: string): GeminiResponse | undefined {
  const data = extractSseData(event);
  if (!data) return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    return isGeminiResponse(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isGeminiPart(value: unknown): value is GeminiPart {
  if (!isRecord(value)) return false;
  const inlineData = value.inlineData;
  return (
    (value.text === undefined || typeof value.text === "string") &&
    (value.thought === undefined || typeof value.thought === "boolean") &&
    (
      inlineData === undefined ||
      (
        isRecord(inlineData) &&
        typeof inlineData.mimeType === "string" &&
        typeof inlineData.data === "string"
      )
    )
  );
}

function isGeminiResponse(value: unknown): value is GeminiResponse {
  if (!isRecord(value)) return false;
  const { candidates, promptFeedback, error } = value;

  return (
    (
      candidates === undefined ||
      (
        Array.isArray(candidates) &&
        candidates.every((candidate) => {
          if (!isRecord(candidate)) return false;
          const content = candidate.content;
          return (
            (candidate.finishReason === undefined || typeof candidate.finishReason === "string") &&
            (
              content === undefined ||
              (
                isRecord(content) &&
                (
                  content.parts === undefined ||
                  (Array.isArray(content.parts) && content.parts.every(isGeminiPart))
                )
              )
            )
          );
        })
      )
    ) &&
    (
      promptFeedback === undefined ||
      (isRecord(promptFeedback) && (
        promptFeedback.blockReason === undefined ||
        typeof promptFeedback.blockReason === "string"
      ))
    ) &&
    (
      error === undefined ||
      (isRecord(error) && (error.message === undefined || typeof error.message === "string"))
    )
  );
}

/**
 * Throw if a chunk reports an upstream error, a safety block at the prompt
 * level, or a blocked finish reason with no usable text. Chunks that finish
 * with `MAX_TOKENS` are *not* thrown here — callers decide how to handle
 * partial output.
 */
function validateGeminiChunk(response: GeminiResponse): void {
  if (response.error?.message) throw new Error(response.error.message);
  if (response.promptFeedback?.blockReason) {
    throw new Error(`Gemini prompt blocked: ${response.promptFeedback.blockReason}`);
  }

  const finishReason = response.candidates?.find((candidate) => candidate.finishReason)
    ?.finishReason;
  if (finishReason && isBlockedFinishReason(finishReason) && !extractGeminiText(response)) {
    throw new Error(`Gemini response blocked: ${finishReason}`);
  }
}

function isBlockedFinishReason(finishReason: string): boolean {
  return [
    "SAFETY",
    "RECITATION",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
  ].includes(finishReason);
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

/**
 * Down-convert a JSON Schema into the OpenAPI-subset
 * dialect Gemini's `generationConfig.responseSchema` accepts: drop JSON-Schema
 * meta/`$defs` keys, convert `const` → single-value typed `enum`, and collapse
 * `["T","null"]` unions into `type: T` + `nullable: true`.
 *
 * `additionalProperties` is stripped because the legacy `responseSchema` dialect
 * rejects it (the full JSON-Schema dialect is only honored via the preview
 * `responseJsonSchema` field). Dropping it does not weaken enforcement: object
 * schemas strip unknown keys on parse, so `validateCompleteAgentAction` returns
 * sanitized data regardless of what extra fields the model emits.
 */
export function toGeminiSchema(schema: JSONSchema): JSONSchema {
  if (Array.isArray(schema)) return schema.map((item) => toGeminiSchema(item as JSONSchema));
  if (!schema || typeof schema !== "object") return schema;

  const next: JSONSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (
      key === "$schema" ||
      key === "$id" ||
      key === "$defs" ||
      key === "definitions" ||
      key === "additionalProperties"
    ) {
      continue;
    }
    // Gemini has no `const`: it takes a one-value `enum`, which must carry a type.
    if (key === "const") {
      next.enum = [value];
      if (schema.type === undefined && ["string", "number", "boolean"].includes(typeof value)) {
        next.type = typeof value;
      }
      continue;
    }
    if (key === "type" && Array.isArray(value)) {
      const withoutNull = value.filter((item) => item !== "null");
      next.type = withoutNull.length === 1 ? withoutNull[0] : withoutNull;
      if (withoutNull.length !== value.length) next.nullable = true;
      continue;
    }
    if (Array.isArray(value)) {
      next[key] = value.map((item) => toGeminiSchema(item as JSONSchema));
      continue;
    }
    if (value && typeof value === "object") {
      next[key] = toGeminiSchema(value as JSONSchema);
      continue;
    }
    next[key] = value;
  }
  return next;
}

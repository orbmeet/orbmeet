import { isRecord } from "@orbmeet/primitives";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";

interface GeminiPart {
  text?: string;
  thought?: boolean;
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
}

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const BLOCKED_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
]);

export interface GenerateGeminiJsonOptions<TSchema extends v.GenericSchema> {
  apiKey: string;
  model: string;
  prompt: string;
  schema: TSchema;
  systemPrompt?: string;
  timeoutMs?: number;
}

export async function generateGeminiJson<TSchema extends v.GenericSchema>(
  options: GenerateGeminiJsonOptions<TSchema>,
): Promise<v.InferOutput<TSchema>> {
  if (!options.apiKey) throw new Error("Missing Gemini API key");

  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(options.model)}:generateContent`;
  const responseSchema = toGeminiSchema(toJsonSchema(options.schema) as Record<string, unknown>);
  const body = {
    ...(options.systemPrompt
      ? { systemInstruction: { parts: [{ text: options.systemPrompt }] } }
      : {}),
    contents: [{ role: "user", parts: [{ text: options.prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": options.apiKey,
    },
    body: JSON.stringify(body),
    signal: options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gemini request failed (${response.status}): ${text || response.statusText}`);
  }

  const parsedJson: unknown = await response.json();
  if (!isGeminiResponse(parsedJson)) {
    throw new Error("Gemini returned an unexpected response shape");
  }
  validateGeminiChunk(parsedJson);

  const rawText = extractGeminiText(parsedJson);
  if (!rawText) throw new Error("Gemini returned an empty structured response");

  let data: unknown;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error("Gemini returned invalid structured JSON");
  }

  return v.parse(options.schema, data);
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

function isGeminiPart(value: unknown): value is GeminiPart {
  if (!isRecord(value)) return false;
  return (
    (value.text === undefined || typeof value.text === "string") &&
    (value.thought === undefined || typeof value.thought === "boolean")
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

function validateGeminiChunk(response: GeminiResponse): void {
  if (response.error?.message) throw new Error(response.error.message);
  if (response.promptFeedback?.blockReason) {
    throw new Error(`Gemini prompt blocked: ${response.promptFeedback.blockReason}`);
  }

  const finishReason = response.candidates?.find((candidate) => candidate.finishReason)
    ?.finishReason;
  if (finishReason && BLOCKED_FINISH_REASONS.has(finishReason) && !extractGeminiText(response)) {
    throw new Error(`Gemini response blocked: ${finishReason}`);
  }
}

/**
 * Down-convert a JSON Schema into the OpenAPI-subset dialect Gemini's
 * `generationConfig.responseSchema` accepts: drop JSON-Schema meta/`$defs`
 * keys, convert `const` -> single-value typed `enum`, and collapse
 * `["T","null"]` unions into `type: T` + `nullable: true`.
 */
export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown>;
export function toGeminiSchema(schema: unknown): unknown;
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((item) => toGeminiSchema(item));
  if (!isRecord(schema)) return schema;

  const next: Record<string, unknown> = {};
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
      next[key] = value.map((item) => toGeminiSchema(item));
      continue;
    }
    if (isRecord(value)) {
      next[key] = toGeminiSchema(value);
      continue;
    }
    next[key] = value;
  }
  return next;
}

import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import { generateGeminiJson, toGeminiSchema } from "./gemini";

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const sampleSchema = v.object({
  summary: v.string(),
  count: v.optional(v.number()),
});

describe("generateGeminiJson", () => {
  it("authenticates with x-goog-api-key and sends a schema-constrained request", async () => {
    const fetchMock = vi.fn<FetchMock>(async () =>
      Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: "Done", count: 2 }) }] } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateGeminiJson({
      apiKey: "test-api-key",
      model: "gemini-3.5-flash",
      prompt: "Summarize this",
      systemPrompt: "Be concise",
      schema: sampleSchema,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ summary: "Done", count: 2 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1beta/models/gemini-3.5-flash:generateContent");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      "x-goog-api-key": "test-api-key",
    });
    expect(init?.headers).not.toHaveProperty("Authorization");
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(sentBody).toMatchObject({
      systemInstruction: { parts: [{ text: "Be concise" }] },
      contents: [{ role: "user", parts: [{ text: "Summarize this" }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            count: { type: "number" },
          },
          required: ["summary"],
        },
      },
    });
  });

  it("skips internal thought parts when assembling structured JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () =>
        Response.json({
          candidates: [
            {
              content: {
                parts: [
                  { text: "internal reasoning not json", thought: true },
                  { text: '{"summary":"Visible"}' },
                ],
              },
            },
          ],
        }),
      ),
    );

    await expect(
      generateGeminiJson({
        apiKey: "test-api-key",
        model: "gemini-3.5-flash",
        prompt: "Hello",
        schema: sampleSchema,
      }),
    ).resolves.toEqual({ summary: "Visible" });
  });

  it("rejects missing API keys before issuing a network call", async () => {
    const fetchMock = vi.fn<FetchMock>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateGeminiJson({
        apiKey: "",
        model: "gemini-3.5-flash",
        prompt: "Hello",
        schema: sampleSchema,
      }),
    ).rejects.toThrow("Missing Gemini API key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces non-OK HTTP statuses, blocked prompts, blocked responses, and provider errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () => new Response("rate limited", { status: 429 })),
    );
    await expect(
      generateGeminiJson({
        apiKey: "test-api-key",
        model: "gemini-3.5-flash",
        prompt: "Hello",
        schema: sampleSchema,
      }),
    ).rejects.toThrow("Gemini request failed (429): rate limited");

    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () =>
        Response.json({ promptFeedback: { blockReason: "SAFETY" } }),
      ),
    );
    await expect(
      generateGeminiJson({
        apiKey: "test-api-key",
        model: "gemini-3.5-flash",
        prompt: "Hello",
        schema: sampleSchema,
      }),
    ).rejects.toThrow("Gemini prompt blocked: SAFETY");

    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () =>
        Response.json({ candidates: [{ finishReason: "RECITATION" }] }),
      ),
    );
    await expect(
      generateGeminiJson({
        apiKey: "test-api-key",
        model: "gemini-3.5-flash",
        prompt: "Hello",
        schema: sampleSchema,
      }),
    ).rejects.toThrow("Gemini response blocked: RECITATION");

    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () =>
        Response.json({ error: { message: "Upstream failure" } }),
      ),
    );
    await expect(
      generateGeminiJson({
        apiKey: "test-api-key",
        model: "gemini-3.5-flash",
        prompt: "Hello",
        schema: sampleSchema,
      }),
    ).rejects.toThrow("Upstream failure");
  });

  it("rejects unexpected response shapes, empty output, and schema mismatches", async () => {
    vi.stubGlobal("fetch", vi.fn<FetchMock>(async () => Response.json("not-an-object")));
    await expect(
      generateGeminiJson({
        apiKey: "test-api-key",
        model: "gemini-3.5-flash",
        prompt: "Hello",
        schema: sampleSchema,
      }),
    ).rejects.toThrow("Gemini returned an unexpected response shape");

    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () => Response.json({ candidates: [{ content: { parts: [] } }] })),
    );
    await expect(
      generateGeminiJson({
        apiKey: "test-api-key",
        model: "gemini-3.5-flash",
        prompt: "Hello",
        schema: sampleSchema,
      }),
    ).rejects.toThrow("Gemini returned an empty structured response");

    vi.stubGlobal(
      "fetch",
      vi.fn<FetchMock>(async () =>
        Response.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ count: "wrong" }) }] } }],
        }),
      ),
    );
    await expect(
      generateGeminiJson({
        apiKey: "test-api-key",
        model: "gemini-3.5-flash",
        prompt: "Hello",
        schema: sampleSchema,
      }),
    ).rejects.toThrow();
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

    const result = generateGeminiJson({
      apiKey: "test-api-key",
      model: "gemini-3.5-flash",
      prompt: "Hello",
      schema: sampleSchema,
    });
    await expect(result).rejects.toThrow("Gemini returned invalid structured JSON");
    await expect(result).rejects.not.toThrow(modelText);
  });
});

describe("toGeminiSchema", () => {
  it("turns a const into a typed one-value enum", () => {
    expect(toGeminiSchema({ const: "message" })).toEqual({ enum: ["message"], type: "string" });
    expect(toGeminiSchema({ type: "string", const: "message" })).toEqual({
      type: "string",
      enum: ["message"],
    });
  });

  it("strips unsupported JSON Schema meta keys and collapses nullable unions", () => {
    expect(
      toGeminiSchema({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "summary",
        $defs: {},
        definitions: {},
        type: "object",
        additionalProperties: false,
        properties: {
          note: { type: ["string", "null"] },
          items: {
            type: "array",
            items: { type: "object", additionalProperties: false, properties: { ok: { const: true } } },
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        note: { type: "string", nullable: true },
        items: {
          type: "array",
          items: { type: "object", properties: { ok: { enum: [true], type: "boolean" } } },
        },
      },
    });
  });
});

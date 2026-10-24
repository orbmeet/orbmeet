import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { TRANSCRIPT_INGEST_PATH } from "@orbmeet/caption-protocol/transcript-ingest";
import type { FileRoutesByFullPath } from "@/routeTree.gen";
import { SIGNATURE_HEADER, parseKeyring, signRequest } from "@orbmeet/primitives";

const env = vi.hoisted(() => ({
  TRANSCRIPTION_INTERNAL_KEYS: JSON.stringify({ primary: "a".repeat(32) }),
}));

vi.mock("@/platform/runtime/server-runtime.server", () => ({ getOptionalEnv: async () => env }));
vi.mock("@/platform/http/rate-limit.server", () => ({
  enforceRateLimit: vi.fn(async () => undefined),
  enforceTranscriptIngestPreAuthRateLimit: vi.fn(async () => undefined),
  rateLimitErrorResponse: vi.fn(),
}));
vi.mock("@/modules/transcripts/server/ingest", () => ({
  ingestDeepgramTranscripts: vi.fn(async () => ({ submitted: 0 })),
}));
vi.mock("@orbmeet/db", () => ({ createDb: () => ({}) }));

const { handleInternalTranscriptRequest } = await import("./-transcripts.server");

const URL_BASE = "https://app.example/api/internal/transcripts";
const body = JSON.stringify({
  meetingId: "meeting_1",
  participantIdentity: "user_1_attempt_1",
  segments: [{ text: "Hello.", startedAt: 1, segmentId: "segment_1" }],
});

async function signed(target: string, method = "POST", keys = env.TRANSCRIPTION_INTERNAL_KEYS) {
  return signRequest({ method, target, body, keyring: parseKeyring(keys)! });
}

function post(signature: string, url = URL_BASE) {
  return new Request(url, { method: "POST", headers: { [SIGNATURE_HEADER]: signature }, body });
}

describe("transcript ingest route", () => {
  it("answers at the path the agent posts to", () => {
    // The file route's path is a literal TanStack reads at build time; this
    // (checked by the type checker) is what keeps it the shared contract's.
    expectTypeOf(TRANSCRIPT_INGEST_PATH).toExtend<keyof FileRoutesByFullPath>();
    expect(new URL(URL_BASE).pathname).toBe(TRANSCRIPT_INGEST_PATH);
  });
});

describe("transcript ingest signature", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts a request signed for this route", async () => {
    const response = await handleInternalTranscriptRequest(post(await signed("/api/internal/transcripts")));
    expect(response.status).toBe(200);
  });

  it("refuses a signature made for another method, path or key", async () => {
    for (const signature of [
      await signed("/api/internal/transcripts", "PUT"),
      await signed("/api/internal/other"),
      await signed("/api/internal/transcripts", "POST", JSON.stringify({ primary: "b".repeat(32) })),
    ]) {
      expect((await handleInternalTranscriptRequest(post(signature))).status).toBe(401);
    }
  });

  it("refuses an unsigned request", async () => {
    const response = await handleInternalTranscriptRequest(new Request(URL_BASE, { method: "POST", body }));
    expect(response.status).toBe(401);
  });
});

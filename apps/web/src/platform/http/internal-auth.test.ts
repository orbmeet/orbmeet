import { afterEach, describe, expect, it, vi } from "vitest";
import { parseKeyring, signRequest, SIGNATURE_HEADER, signatureTarget } from "@orbmeet/primitives";
import { logError, logWarn } from "@/lib/logger";

vi.mock("@/lib/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));

const { readSignedRequest } = await import("./internal-auth");

const TARGET_URL = "https://orbmeet.test/api/internal/transcripts";
const BODY = '{"x":1}';

function keyring(entries: Record<string, string>) {
  const parsed = parseKeyring(JSON.stringify(entries));
  if (!parsed) throw new Error("invalid test keyring");
  return parsed;
}

const ours = keyring({ current: "a".repeat(40) });

function request(header?: string) {
  return new Request(TARGET_URL, { method: "POST", body: BODY, headers: header ? { [SIGNATURE_HEADER]: header } : {} });
}

const signedWith = (ring: ReturnType<typeof keyring>, nowSeconds?: number) =>
  signRequest({ method: "POST", target: signatureTarget(TARGET_URL), body: BODY, keyring: ring, nowSeconds });

afterEach(() => {
  vi.clearAllMocks();
});

describe("readSignedRequest", () => {
  it("reads a request signed with the keyring", async () => {
    const result = await readSignedRequest(request(await signedWith(ours)), ours, 1024);
    expect(result).toMatchObject({ ok: true, body: BODY, keyId: "current" });
    expect(logError).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("reports a peer signing with a key the Worker does not hold as an error", async () => {
    const rotatedAway = keyring({ next: "b".repeat(40) });
    const result = await readSignedRequest(request(await signedWith(rotatedAway)), ours, 1024);
    expect(result.ok || result.response.status).toBe(401);
    expect(logError).toHaveBeenCalledWith("[internal-auth] Refused a peer's signature", {
      path: "/api/internal/transcripts", reason: "unknown_key",
    });
  });

  it("reports a peer whose clock has drifted as an error", async () => {
    const result = await readSignedRequest(request(await signedWith(ours, Math.floor(Date.now() / 1000) - 3600)), ours, 1024);
    expect(result.ok || result.response.status).toBe(401);
    expect(logError).toHaveBeenCalledWith("[internal-auth] Refused a peer's signature", expect.objectContaining({ reason: "expired" }));
  });

  it("only warns of a request anyone could have sent", async () => {
    const result = await readSignedRequest(request(), ours, 1024);
    expect(result.ok || result.response.status).toBe(401);
    expect(logError).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith("[internal-auth] Refused an internal request's signature", {
      path: "/api/internal/transcripts", reason: "missing",
    });
  });
});

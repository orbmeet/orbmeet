import { describe, expect, it, vi } from "vitest";
import { parseKeyring } from "@orbmeet/primitives";
import { MAX_AUTHORITY_CLAIMS, type AuthorityClaim } from "@orbmeet/whiteboard-core/sync-commands";
import { toWhiteboardRoomId } from "@orbmeet/whiteboard-core/whiteboard-room-id";
import { createAuthorityClient } from "./authority-client.ts";

const keyring = parseKeyring(JSON.stringify({ k1: "k".repeat(32) }))!;
const roomId = toWhiteboardRoomId("room-1");

function claim(index: number): AuthorityClaim {
  return {
    sub: `user-${index}`,
    role: "participant",
    connectionId: `connection-${index}`,
    grantPrincipalKey: `user:user-${index}`,
    capabilities: { canEditWhiteboard: true, canControlSurface: false, canManageWhiteboard: false },
  };
}

/**
 * A Worker that answers each claim by its user (odd users are denied),
 * recording the size of every request it receives.
 */
function worker(fail?: (batch: number) => boolean) {
  const batches: number[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { claims } = JSON.parse(String(init?.body)) as { claims: AuthorityClaim[] };
    batches.push(claims.length);
    if (fail?.(batches.length)) return new Response("down", { status: 503 });
    return Response.json({ verdicts: claims.map(verdictFor) });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, batches };
}

function verdictFor({ sub }: AuthorityClaim) {
  return Number(sub.slice("user-".length)) % 2 === 0 ? "active" : "denied";
}

describe("authority client", () => {
  it("asks nothing for a room with no claims", async () => {
    const { fetch, batches } = worker();
    const client = createAuthorityClient({ appUrl: "https://app.test", keyring, fetch });
    await expect(client.verdicts(roomId, [])).resolves.toEqual([]);
    expect(batches).toEqual([]);
  });

  it("splits a room holding more claims than one request allows, in order", async () => {
    const { fetch, batches } = worker();
    const client = createAuthorityClient({ appUrl: "https://app.test", keyring, fetch });
    const claims = Array.from({ length: MAX_AUTHORITY_CLAIMS + 3 }, (_, index) => claim(index));

    const verdicts = await client.verdicts(roomId, claims);

    expect([...batches].sort((a, b) => b - a)).toEqual([MAX_AUTHORITY_CLAIMS, 3]);
    // Requests run concurrently; verdicts still line up with their claims.
    expect(verdicts).toEqual(claims.map(verdictFor));
  });

  it("is unavailable when any part goes unanswered", async () => {
    const { fetch } = worker((batch) => batch === 2);
    const client = createAuthorityClient({ appUrl: "https://app.test", keyring, fetch });
    const claims = Array.from({ length: MAX_AUTHORITY_CLAIMS + 1 }, (_, index) => claim(index));

    await expect(client.verdicts(roomId, claims)).resolves.toBe("unavailable");
  });
});

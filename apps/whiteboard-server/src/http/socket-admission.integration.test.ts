import { describe, expect, it } from "vitest";
import { TLSyncErrorCloseEventReason } from "@tldraw/sync-core";
import { createWhiteboardJWT } from "@orbmeet/whiteboard-core/whiteboard-jwt";
import { incomingRequest } from "../../test/requests.ts";
import { fakeAuthority } from "../rooms/room-test-support.ts";
import type { AuthorityValidator } from "./authority-client.ts";
import { admitWhiteboardSocket } from "./socket-admission.ts";
import { TEST_JWT_KEYRING } from "./test-keyrings.ts";


function token() {
  return createWhiteboardJWT(TEST_JWT_KEYRING, {
    sub: "user-1",
    name: "User",
    role: "participant",
    capabilities: {
      canEditWhiteboard: true,
      canControlSurface: false,
      canManageWhiteboard: false,
    },
    sid: "meet-room",
    connectionId: "connection-1",
    grantPrincipal: { type: "user", id: "user-1" },
  });
}

async function admit(
  protocols: string | null,
  {
    authority = fakeAuthority(),
    origin = "https://app.example",
    allowed = true,
  }: { authority?: AuthorityValidator; origin?: string; allowed?: boolean } = {},
) {
  return admitWhiteboardSocket(
    incomingRequest({
      url: "/connect",
      headers: {
        Origin: origin,
        ...(protocols === null ? {} : { "Sec-WebSocket-Protocol": protocols }),
      },
    }),
    {
      allowedOrigins: ["https://app.example"],
      allowInsecureAllOrigins: false,
      trustedProxyIps: [],
      ipRateLimiter: { check: () => allowed },
      jwtKeyring: TEST_JWT_KEYRING,
      authority,
    },
  );
}

describe("WebSocket admission", () => {
  it("admits a verified token as its session", async () => {
    const admission = await admit(`orbmeet-wb, ${await token()}`);
    expect(admission).toMatchObject({
      type: "admitted",
      session: { userId: "user-1", whiteboardRoomId: "meet-room", connectionId: "connection-1" },
    });
  });

  it("closes the socket of a token the Worker denies, without admitting it", async () => {
    expect(await admit(`orbmeet-wb, ${await token()}`, { authority: fakeAuthority("denied") }))
      .toEqual({ type: "rejected", reason: TLSyncErrorCloseEventReason.FORBIDDEN });
  });

  it("asks a client without a token to authenticate", async () => {
    expect(await admit("orbmeet-wb")).toEqual({
      type: "rejected",
      reason: TLSyncErrorCloseEventReason.NOT_AUTHENTICATED,
    });
    expect(await admit(null)).toEqual({
      type: "rejected",
      reason: TLSyncErrorCloseEventReason.NOT_AUTHENTICATED,
    });
  });

  it("refuses a foreign origin", async () => {
    expect(await admit(`orbmeet-wb, ${await token()}`, { origin: "https://evil.example" }))
      .toEqual({ type: "rejected", reason: TLSyncErrorCloseEventReason.FORBIDDEN });
  });

  it("answers a rate-limited client over plain HTTP, before any handshake", async () => {
    const admission = await admit(`orbmeet-wb, ${await token()}`, { allowed: false });
    expect(admission).toMatchObject({ type: "refused", reply: { status: 429, headers: { "Retry-After": "1" } } });
  });
});

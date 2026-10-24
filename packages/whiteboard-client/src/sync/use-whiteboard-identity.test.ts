import { describe, expect, it } from "vitest";
import { decodeWhiteboardJwt } from "./use-whiteboard-identity";
import { base64urlEncode } from "@orbmeet/whiteboard-core/crypto-utils";

function tokenFor(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

describe("decodeWhiteboardJwt", () => {
  it("reads identity and manager capability from the payload", () => {
    expect(
      decodeWhiteboardJwt(
        tokenFor({
          sub: "user_1",
          name: "Ada",
          capabilities: { canManageWhiteboard: true },
        }),
      ),
    ).toEqual({ userId: "user_1", userName: "Ada", isHost: true, error: null });
  });

  // The payload is UTF-8, so a byte-per-char decode (atob alone) turns every
  // non-ASCII name into mojibake — and this name labels the user's cursor for
  // every other participant.
  it("decodes non-ASCII display names as UTF-8", () => {
    for (const name of ["Zoë", "李雷", "Ali 👋", "Ægir Þórsson"]) {
      expect(decodeWhiteboardJwt(tokenFor({ sub: "u", name, capabilities: {} })).userName)
        .toBe(name);
    }
  });

  it("treats a non-boolean manager capability as not a host", () => {
    expect(
      decodeWhiteboardJwt(
        tokenFor({ sub: "u", name: "n", capabilities: { canManageWhiteboard: "yes" } }),
      ).isHost,
    ).toBe(false);
    expect(decodeWhiteboardJwt(tokenFor({ sub: "u", name: "n" })).isHost).toBe(false);
  });

  it("reports malformed tokens instead of throwing", () => {
    expect(decodeWhiteboardJwt("not-a-jwt")).toEqual({
      userId: null,
      userName: "",
      isHost: false,
      error: "Whiteboard token is invalid.",
    });
    expect(decodeWhiteboardJwt("a.!!!not-base64!!!.c").error).toBe(
      "Whiteboard token is invalid.",
    );
  });

  it("falls back to empty values for missing claims", () => {
    const identity = decodeWhiteboardJwt(tokenFor({ capabilities: {} }));
    expect(identity.userId).toBeNull();
    expect(identity.userName).toBe("");
    expect(identity.error).toBeNull();
  });
});

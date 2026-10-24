import { describe, expect, it } from "vitest";
import { MAX_PASSKEY_CREDENTIAL_ID_LENGTH } from "@orbmeet/domain-model";
import { hasValidCredentialId } from "./webauthn";

describe("webauthn contract", () => {
  it("accepts well-formed credential ids and rejects the rest", () => {
    expect(hasValidCredentialId({ id: "a".repeat(43) })).toBe(true);
    expect(hasValidCredentialId({ id: "" })).toBe(false);
    expect(hasValidCredentialId({ id: "not base64url!" })).toBe(false);
    expect(hasValidCredentialId({ id: "a".repeat(MAX_PASSKEY_CREDENTIAL_ID_LENGTH + 1) })).toBe(
      false,
    );
    expect(hasValidCredentialId(null)).toBe(false);
    expect(hasValidCredentialId("string")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

// Runs in workerd: proves the WebAuthn verifier works in the Worker runtime,
// using a software ES256 authenticator in place of a browser.

const RP_ID = "orbmeet.test";
const ORIGIN = `https://${RP_ID}`;

type Bytes = Uint8Array<ArrayBuffer>;

async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** WebCrypto signs ECDSA as raw r||s; WebAuthn carries a DER SEQUENCE. */
function rawEcdsaToDer(raw: Bytes): Bytes {
  const integer = (bytes: Bytes) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const trimmed = bytes.slice(start);
    const value = trimmed[0] & 0x80 ? concat(new Uint8Array([0]), trimmed) : trimmed;
    return concat(new Uint8Array([0x02, value.length]), value);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

async function createCredential() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const cosePublicKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, isoBase64URL.toBuffer(jwk.x!)],
      [-3, isoBase64URL.toBuffer(jwk.y!)],
    ]),
  );
  return { privateKey: keyPair.privateKey, cosePublicKey };
}

async function signAssertion(privateKey: CryptoKey, challenge: string, signCount: number) {
  const flags = 0x01 | 0x04; // user present, user verified
  const counter = new Uint8Array(4);
  new DataView(counter.buffer).setUint32(0, signCount);
  const authenticatorData = concat(
    await sha256(new TextEncoder().encode(RP_ID)),
    new Uint8Array([flags]),
    counter,
  );
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }),
  );
  const signed = concat(authenticatorData, await sha256(clientDataJSON));
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, signed),
  );
  return {
    authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
    clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
    signature: isoBase64URL.fromBuffer(rawEcdsaToDer(raw)),
  };
}

describe("passkey assertion verification in the Worker runtime", () => {
  const credentialId = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));

  it("verifies an ES256 assertion and reports the new counter", async () => {
    const { privateKey, cosePublicKey } = await createCredential();
    const response = await signAssertion(privateKey, challenge, 7);

    const result = await verifyAuthenticationResponse({
      response: {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response,
        clientExtensionResults: {},
      },
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: { id: credentialId, publicKey: cosePublicKey, counter: 0 },
      requireUserVerification: true,
    });

    expect(result.verified).toBe(true);
    expect(result.authenticationInfo.newCounter).toBe(7);
  });

  it("rejects an assertion signed by a different key", async () => {
    const { cosePublicKey } = await createCredential();
    const { privateKey: otherKey } = await createCredential();
    const response = await signAssertion(otherKey, challenge, 1);

    const result = await verifyAuthenticationResponse({
      response: {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response,
        clientExtensionResults: {},
      },
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: { id: credentialId, publicKey: cosePublicKey, counter: 0 },
      requireUserVerification: true,
    });

    expect(result.verified).toBe(false);
  });
});

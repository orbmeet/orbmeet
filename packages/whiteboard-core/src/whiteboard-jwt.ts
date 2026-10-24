import { signingKey, type Keyring } from "@orbmeet/primitives";
import { errors, jwtVerify, SignJWT } from "jose";
import * as v from "valibot";
import {
  isWhiteboardGrantPrincipal,
  type WhiteboardGrantPrincipal,
} from "./whiteboard-grant-principal.ts";
import { isWhiteboardRoomId, type WhiteboardRoomId } from "./whiteboard-room-id.ts";

const ISSUER = "orbmeet";
const AUDIENCE = "whiteboard";
const MAX_WHITEBOARD_JWT_TTL_SECONDS = 24 * 3600;
const MAX_WHITEBOARD_JWT_CLOCK_SKEW_SECONDS = 60;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
export const WHITEBOARD_ROLES = ["participant", "guest"] as const;
export type WhiteboardRole = (typeof WHITEBOARD_ROLES)[number];
export interface WhiteboardCapabilities {
  canEditWhiteboard: boolean;
  /** May open or close the Meeting-wide shared surface. */
  canControlSurface: boolean;
  canManageWhiteboard: boolean;
}

/** Printable text of at most `max` characters, at least `min`. */
function text(min: number, max: number, message: string) {
  return v.pipe(
    v.string(message),
    v.minLength(min, message),
    v.maxLength(max, message),
    v.check((value) => !CONTROL_CHARACTERS.test(value), message),
  );
}

// `sub` and `connectionId` are authorization identity, not display data: they
// key rate limiters, assistant tool routing, connections and grant lookups,
// so an empty one would collapse separate callers into one bucket. `name` is
// only ever rendered, and issuers pass display names straight through, so an
// empty name is allowed.
const IDENTITY_MESSAGE = "JWT sub and connectionId claims must be valid non-empty identities";

/**
 * The claims a verified token may carry. Parsing builds a new object of
 * exactly these keys, so a field an issuer added and this verifier does not
 * know never becomes a trusted input downstream.
 */
const claimsSchema = v.object(
  {
    sub: text(1, 256, IDENTITY_MESSAGE),
    name: text(0, 256, "JWT name claim contains invalid characters or is too long"),
    role: v.picklist(WHITEBOARD_ROLES, "Invalid JWT role"),
    capabilities: v.object(
      {
        canEditWhiteboard: v.boolean(),
        canControlSurface: v.boolean(),
        canManageWhiteboard: v.boolean(),
      },
      "JWT missing required capabilities",
    ),
    // Every caller uses `sid` as a room identity, and some reach storage paths
    // with it, so only a well-formed room id is accepted.
    sid: v.custom<WhiteboardRoomId>(
      (value) => typeof value === "string" && isWhiteboardRoomId(value),
      "Invalid JWT whiteboard room id",
    ),
    connectionId: text(1, 256, IDENTITY_MESSAGE),
    grantPrincipal: v.pipe(
      v.custom<WhiteboardGrantPrincipal>(isWhiteboardGrantPrincipal, "Invalid JWT grant principal"),
      v.transform(({ type, id }): WhiteboardGrantPrincipal => ({ type, id })),
    ),
    service: v.optional(text(1, 64, "Invalid JWT service claim")),
    /** Durable document identity used to bind storage-backed asset writes. */
    documentId: v.optional(text(1, 128, "Invalid JWT document id")),
    /**
     * The board's generation when the token was minted: the node it was minted
     * for holds this generation, and a token from before the board moved on
     * is refreshed rather than served from a stale copy.
     */
    generation: v.optional(v.pipe(
      v.number(),
      v.safeInteger("JWT generation must be a safe integer"),
      v.minValue(0, "JWT generation must not be negative"),
    )),
    exp: v.pipe(v.number(), v.safeInteger("JWT timestamps must be safe integers")),
    iat: v.pipe(v.number(), v.safeInteger("JWT timestamps must be safe integers")),
    iss: v.string(),
    aud: v.union([
      v.string(),
      v.pipe(v.array(v.pipe(v.string(), v.maxLength(128))), v.maxLength(16)),
    ], "Invalid JWT audience"),
  },
  "JWT missing required claims (sub, name, role, capabilities, sid, grantPrincipal, exp, iat, iss, aud)",
);

export type WhiteboardJWTClaims = v.InferOutput<typeof claimsSchema>;

export type WhiteboardJWTPayload = Omit<WhiteboardJWTClaims, "exp" | "iat" | "iss" | "aud">;

/**
 * Create a signed JWT for whiteboard server authentication, with the
 * keyring's first key. Each node has its own keyring, so the header's `kid`
 * names the key and through it the node the token was minted for.
 */
export async function createWhiteboardJWT(
  keyring: Keyring,
  payload: WhiteboardJWTPayload,
  expiresInSeconds = 3600,
): Promise<string> {
  const { keyId, secret } = signingKey(keyring);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: keyId })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(new TextEncoder().encode(secret));
}

class UnknownKeyError extends Error {}

/** Verify a token against whichever key of `keyring` its `kid` names; a token naming no key there is refused. */
export async function verifyWhiteboardJWT(
  token: string,
  keyring: Keyring,
): Promise<WhiteboardJWTClaims> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, ({ kid }) => {
      const secret = kid === undefined ? undefined : keyring.get(kid);
      if (!secret) throw new UnknownKeyError();
      return new TextEncoder().encode(secret);
    }, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      requiredClaims: ["exp", "iat"],
    }));
  } catch (error) {
    throw new Error(verificationFailure(error), { cause: error });
  }

  const claims = v.parse(claimsSchema, payload);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iat > now + MAX_WHITEBOARD_JWT_CLOCK_SKEW_SECONDS) {
    throw new Error("JWT issued-at is in the future");
  }
  if (claims.exp < claims.iat) throw new Error("JWT expires before it was issued");
  if (claims.exp - claims.iat > MAX_WHITEBOARD_JWT_TTL_SECONDS) {
    throw new Error("JWT lifetime is too long");
  }
  return claims;
}

function verificationFailure(error: unknown): string {
  if (error instanceof UnknownKeyError) return "Unknown JWT key";
  if (error instanceof errors.JWTExpired) return "JWT expired";
  if (error instanceof errors.JWSSignatureVerificationFailed) return "Invalid JWT signature";
  if (error instanceof errors.JOSEAlgNotAllowed) return "Invalid JWT algorithm";
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "iss") return "Invalid JWT issuer";
    if (error.claim === "aud") return "Invalid JWT audience";
    return `Invalid JWT ${error.claim} claim`;
  }
  return "Invalid JWT format";
}

import {
  base64urlDecode,
  base64urlEncode,
  importHmacSha256Key,
} from "@orbmeet/whiteboard-core/crypto-utils";
const enc = new TextEncoder();
const MAX_RECORDER_BOOTSTRAP_CLOCK_SKEW_SECONDS = 60;
/**
 * The credential rides in the egress page's URL for the whole recording, and
 * the recorder presents it again for every board and every token refresh, so
 * it lives as long as a recording can. It grants nothing on its own: each
 * exchange also requires the meeting to be recording or streaming right then.
 */
export const RECORDER_BOOTSTRAP_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const MEETING_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Names a meeting, not a board: the recorder follows whichever board the
 * meeting presents, including one presented after the recording started.
 */
export interface RecorderBootstrapClaims {
  purpose: "whiteboard-recorder-bootstrap";
  meetingId: string;
  nonce: string;
  iat: number;
  exp: number;
}

/**
 * The token's key: only the Worker issues and redeems it, so it is derived
 * from the Worker's own secret rather than any node's.
 */
function bootstrapSecret(env: Pick<Env, "AUTH_SECRET">): string {
  if (!env.AUTH_SECRET) throw new Error("AUTH_SECRET is not set");
  return `whiteboard-recorder-bootstrap:${env.AUTH_SECRET}`;
}

export async function createRecorderBootstrapToken(
  env: Pick<Env, "AUTH_SECRET">,
  meetingId: string,
): Promise<string> {
  const secret = bootstrapSecret(env);
  const now = Math.floor(Date.now() / 1000);
  const claims: RecorderBootstrapClaims = {
    purpose: "whiteboard-recorder-bootstrap",
    meetingId,
    nonce: crypto.randomUUID(),
    iat: now,
    exp: now + RECORDER_BOOTSTRAP_TOKEN_TTL_SECONDS,
  };
  const payload = base64urlEncode(enc.encode(JSON.stringify(claims)));
  const key = await importHmacSha256Key(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `${payload}.${base64urlEncode(new Uint8Array(signature))}`;
}

export async function verifyRecorderBootstrapToken(
  token: string,
  env: Pick<Env, "AUTH_SECRET">,
): Promise<RecorderBootstrapClaims> {
  const secret = bootstrapSecret(env);
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Invalid recorder bootstrap token format");
  const [payload, signature] = parts;

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64urlDecode(signature);
  } catch {
    throw new Error("Invalid recorder bootstrap token signature encoding");
  }

  const key = await importHmacSha256Key(secret, ["verify"]);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes as BufferSource,
    enc.encode(payload),
  );
  if (!valid) throw new Error("Invalid recorder bootstrap token signature");

  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payload)));
  } catch {
    throw new Error("Invalid recorder bootstrap token payload");
  }

  if (
    !claims ||
    typeof claims !== "object" ||
    (claims as RecorderBootstrapClaims).purpose !== "whiteboard-recorder-bootstrap" ||
    typeof (claims as RecorderBootstrapClaims).meetingId !== "string" ||
    typeof (claims as RecorderBootstrapClaims).nonce !== "string" ||
    typeof (claims as RecorderBootstrapClaims).iat !== "number" ||
    typeof (claims as RecorderBootstrapClaims).exp !== "number"
  ) {
    throw new Error("Recorder bootstrap token missing required claims");
  }

  const validated = claims as RecorderBootstrapClaims;
  if (!MEETING_ID_REGEX.test(validated.meetingId)) {
    throw new Error("Invalid recorder bootstrap meeting id");
  }
  if (!/^[a-f0-9-]{36}$/i.test(validated.nonce)) {
    throw new Error("Invalid recorder bootstrap nonce");
  }
  const now = Math.floor(Date.now() / 1000);
  if (validated.iat > now + MAX_RECORDER_BOOTSTRAP_CLOCK_SKEW_SECONDS) {
    throw new Error("Recorder bootstrap token issued-at is in the future");
  }
  if (validated.exp <= now - MAX_RECORDER_BOOTSTRAP_CLOCK_SKEW_SECONDS) {
    throw new Error("Recorder bootstrap token has expired");
  }
  if (validated.exp <= validated.iat) {
    throw new Error("Recorder bootstrap token expiry is invalid");
  }
  if (
    validated.exp - validated.iat >
      RECORDER_BOOTSTRAP_TOKEN_TTL_SECONDS + MAX_RECORDER_BOOTSTRAP_CLOCK_SKEW_SECONDS
  ) {
    throw new Error("Recorder bootstrap token lifetime is too long");
  }

  return validated;
}

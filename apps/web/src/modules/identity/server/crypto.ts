import { EMAIL_CODE_ALPHABET, EMAIL_CODE_LENGTH } from "@/modules/identity/contract/auth/constants";
import { hmacSha256Hex } from "@/platform/crypto/tokens.server";

// Only the email-code primitives live here — they are bound to identity's own
// code alphabet and length. Session tokens, guest secrets, invite codes and
// timing-safe comparison are shared infrastructure in
// `@/platform/crypto/tokens.server`.

/**
 * Hash OTP with server secret as HMAC key, email as part of the message
 * Uses server-side secret instead of email as the HMAC key
 */
export async function hashOtp(otp: string, email: string, secret: string): Promise<string> {
  if (!secret) {
    throw new Error("AUTH_SECRET is required for OTP hashing");
  }
  // Include email in the message so OTPs are scoped to specific emails
  return hmacSha256Hex(secret, `${email}:${otp}`);
}

/** Generate a uniformly distributed six-digit email authentication code. */
export function generateOtp(): string {
  let code = "";
  while (code.length < EMAIL_CODE_LENGTH) {
    const bytes = crypto.getRandomValues(
      new Uint8Array(EMAIL_CODE_LENGTH - code.length),
    );
    for (const byte of bytes) {
      // Reject the top six byte values so modulo 10 is unbiased.
      if (byte < 250) {
        code += EMAIL_CODE_ALPHABET[byte % EMAIL_CODE_ALPHABET.length];
      }
    }
  }
  return code;
}

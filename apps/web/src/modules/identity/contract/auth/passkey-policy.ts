export const PASSKEY_USER_VERIFICATION = "required" as const;
export const REQUIRE_PASSKEY_USER_VERIFICATION = true;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPasskeyChallengeId(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

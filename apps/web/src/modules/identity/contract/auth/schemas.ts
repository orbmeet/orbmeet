import * as v from "valibot";
import { APPEARANCES } from "@orbmeet/domain-model";
import { emailSchema, idSchema, timeZoneSchema, trimmedText } from "@orbmeet/public-api-contract/fields";
import { EMAIL_CODE_ALPHABET, EMAIL_CODE_LENGTH } from "./constants";

const emailCodeSchema = v.pipe(
  v.string(),
  v.trim(),
  v.regex(
    new RegExp(`^[${EMAIL_CODE_ALPHABET}]{${EMAIL_CODE_LENGTH}}$`),
    `Code must be exactly ${EMAIL_CODE_LENGTH} digits`,
  ),
);

/** The `id.secret` token that names one pending authentication flow. */
export const authFlowTokenSchema = v.pipe(
  v.string(),
  v.maxLength(128),
  v.regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-f0-9]{64}$/i,
    "Invalid authentication flow",
  ),
);

/** A one-time code proving the caller controls the account's email right now. */
export const stepUpCredentialSchema = v.object({
  flowToken: authFlowTokenSchema,
  otp: emailCodeSchema,
});

/** The body of a request whose only input is a step-up credential. */
export const stepUpBodySchema = v.object({ credential: stepUpCredentialSchema });
export type StepUpBody = v.InferOutput<typeof stepUpBodySchema>;

/** A one-time code's verification takes the same credential as a step-up. @alias */
export const otpVerifySchema = stepUpCredentialSchema;

export const resendOtpSchema = v.object({
  flowToken: authFlowTokenSchema,
});

export const beginEmailAuthSchema = v.object({
  email: v.pipe(v.string(), v.trim(), emailSchema),
  name: v.optional(trimmedText(100, "Full name is required")),
});

export const updateProfileSchema = v.object({
  name: trimmedText(100, "Name is required"),
  timeZone: v.optional(timeZoneSchema),
});

export const setTranscribeMeetingsSchema = v.object({ on: v.boolean() });

export const setAppearanceSchema = v.object({ appearance: v.picklist(APPEARANCES) });

export const revokeSessionSchema = v.object({
  sessionId: idSchema,
  credential: stepUpCredentialSchema,
});

export const STEP_UP_ACTIONS = [
  "passkey_register",
  "passkey_delete",
  "session_revoke",
  "sessions_revoke_others",
  "google_link",
  "google_unlink",
  "account_delete",
  // An API key is a bearer credential with no session chain behind it: it does
  // not rotate, it is not tied to a device, and it outlives the session that
  // minted it. Minting one therefore belongs with the other durable-credential
  // mutations rather than behind a live cookie alone.
  "api_key_create",
] as const;

export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

export const stepUpRequestSchema = v.object({
  action: v.picklist(STEP_UP_ACTIONS),
  targetId: v.optional(v.pipe(v.string(), v.nonEmpty(), v.maxLength(200))),
});

export const deleteAccountSchema = v.object({
  confirmation: v.literal("DELETE"),
  /**
   * Required for a first deletion attempt (it carries the step-up OTP), but
   * optional overall: a resumed attempt — an interruption recovery driven from
   * the deletion-pending page — already crossed the durable authorization
   * boundary and authorizes through its retained continuation session instead.
   * The handler still demands a credential whenever the gate marker was not
   * already set.
   */
  credential: v.optional(stepUpCredentialSchema),
});

export const googleCallbackSchema = v.object({
  // Google does not document a code length; observed codes are under 100.
  code: v.pipe(v.string(), v.nonEmpty(), v.maxLength(512)),
  state: idSchema,
});

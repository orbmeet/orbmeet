import * as v from "valibot";
import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import { idSchema } from "@orbmeet/public-api-contract/fields";
import { authFlowTokenSchema, stepUpCredentialSchema } from "@/modules/identity/contract/auth/schemas";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { hasValidCredentialId } from "@/modules/identity/contract/auth/webauthn";
import { isPasskeyChallengeId } from "@/modules/identity/contract/auth/passkey-policy";
import { startPasskeyRegistrationImpl, finishPasskeyRegistrationImpl, startPasskeyAuthenticationImpl, finishPasskeyAuthenticationImpl, listPasskeysImpl, deletePasskeyImpl } from "./passkey.server";

/** A WebAuthn response from the browser; the ceremony itself verifies the rest. */
const passkeyResponseSchema = v.custom<{ id: string }>(hasValidCredentialId, "Invalid passkey response");

/** Registration is authorised by exactly one of a step-up code or a signup grant. */
const startPasskeyRegistrationSchema = v.pipe(
  v.object({
    credential: v.optional(stepUpCredentialSchema),
    signupGrant: v.optional(v.pipe(v.string(), v.maxLength(128))),
  }),
  v.partialCheck(
    [["credential"], ["signupGrant"]],
    ({ credential, signupGrant }) => (credential === undefined) !== (signupGrant === undefined),
    "Exactly one passkey authorization is required",
  ),
);

const finishPasskeyRegistrationSchema = v.object({
  response: passkeyResponseSchema,
  name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  registrationToken: authFlowTokenSchema,
});

const finishPasskeyAuthenticationSchema = v.object({
  challengeId: v.pipe(v.string(), v.check(isPasskeyChallengeId, "Invalid challenge")),
  response: passkeyResponseSchema,
});

const deletePasskeySchema = v.object({
  passkeyId: idSchema,
  credential: stepUpCredentialSchema,
});

export const startPasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(startPasskeyRegistrationSchema))
  .handler(async ({ data, context }) => {
    return startPasskeyRegistrationImpl({ data, context });
  });

export const finishPasskeyRegistration = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(finishPasskeyRegistrationSchema))
  .handler(async ({ data, context }) => {
    return finishPasskeyRegistrationImpl({ data, context });
  });

export const startPasskeyAuthentication = createServerFn({ method: "POST" }).handler(async () => {
  return startPasskeyAuthenticationImpl();
});

export const finishPasskeyAuthentication = createServerFn({ method: "POST" })
  .validator(serverInput(finishPasskeyAuthenticationSchema))
  .handler(async ({ data }) => {
    return finishPasskeyAuthenticationImpl({ data });
  });

export const listPasskeys = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return listPasskeysImpl({ context });
  });

export const deletePasskey = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(deletePasskeySchema))
  .handler(async ({ data, context }) => {
    return deletePasskeyImpl({ data, context });
  });

export type StartPasskeyRegistrationInput = v.InferOutput<typeof startPasskeyRegistrationSchema>;
export type FinishPasskeyRegistrationInput = v.InferOutput<typeof finishPasskeyRegistrationSchema>;
export type FinishPasskeyAuthenticationInput = v.InferOutput<typeof finishPasskeyAuthenticationSchema>;
export type DeletePasskeyInput = v.InferOutput<typeof deletePasskeySchema>;

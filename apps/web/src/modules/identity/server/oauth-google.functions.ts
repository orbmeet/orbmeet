import { createServerFn } from "@tanstack/react-start";
import * as v from "valibot";
import { serverInput } from "@/lib/validation";
import { stepUpBodySchema } from "@/modules/identity/contract/auth/schemas";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { getGoogleAuthUrlImpl, getGoogleLinkUrlImpl, unlinkGoogleAccountImpl, getLinkedAccountsImpl } from "./oauth-google.server";

/**
 * Where to land after sign-in. Only a hint: anything unusable is dropped, and
 * `sanitizeInternalRedirect` decides what is actually followed.
 */
const getGoogleAuthUrlSchema = v.fallback(
  v.object({ redirectTo: v.fallback(v.optional(v.pipe(v.string(), v.maxLength(2048))), undefined) }),
  { redirectTo: undefined },
);

export const getGoogleAuthUrl = createServerFn({ method: "POST" })
  .validator(serverInput(getGoogleAuthUrlSchema))
  .handler(async ({ data }) => {
    return getGoogleAuthUrlImpl({ data });
  });

export const getGoogleLinkUrl = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(stepUpBodySchema))
  .handler(async ({ data, context }) => {
    return getGoogleLinkUrlImpl({ data, context });
  });

export const unlinkGoogleAccount = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(stepUpBodySchema))
  .handler(async ({ data, context }) => {
    return unlinkGoogleAccountImpl({ data, context });
  });

export const getLinkedAccounts = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return getLinkedAccountsImpl({ context });
  });

export type GetGoogleAuthUrlInput = v.InferOutput<typeof getGoogleAuthUrlSchema>;

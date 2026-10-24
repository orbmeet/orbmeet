import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import {
  createPersonalAccessTokenSchema,
  revokePersonalAccessTokenSchema,
} from "@orbmeet/public-api-contract";
import { stepUpCredentialSchema } from "@/modules/identity/contract/auth/schemas";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { listPersonalAccessTokensImpl, createPersonalAccessTokenImpl, revokePersonalAccessTokenImpl } from "./personal-access-tokens.server";

const createPersonalAccessTokenRequestSchema = v.object({
  ...createPersonalAccessTokenSchema.entries,
  credential: stepUpCredentialSchema,
});

export const listPersonalAccessTokens = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return listPersonalAccessTokensImpl({ context });
  });

export const createPersonalAccessToken = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(createPersonalAccessTokenRequestSchema))
  .handler(async ({ data, context }) => {
    return createPersonalAccessTokenImpl({ data, context });
  });

export const revokePersonalAccessToken = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(revokePersonalAccessTokenSchema))
  .handler(async ({ data, context }) => {
    return revokePersonalAccessTokenImpl({ data, context });
  });

export type CreatePersonalAccessTokenRequestInput = v.InferOutput<typeof createPersonalAccessTokenRequestSchema>;

import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import {
  revokeSessionSchema,
  setAppearanceSchema,
  setTranscribeMeetingsSchema,
  stepUpBodySchema,
  updateProfileSchema,
} from "@/modules/identity/contract/auth/schemas";
import { accountDeletionAuthMiddleware, authMiddleware } from "@/app/bootstrap/middleware";
import {
  updateProfileImpl,
  listSessionsImpl,
  revokeSessionImpl,
  revokeAllOtherSessionsImpl,
  getDeletionPendingAccountImpl,
  setTranscribeMeetingsImpl,
  setAppearanceImpl,
} from "./account.server";

export const updateProfile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(updateProfileSchema))
  .handler(async ({ data, context }) => {
    return updateProfileImpl({ data, context });
  });

export const setTranscribeMeetings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(setTranscribeMeetingsSchema))
  .handler(async ({ data, context }) => {
    return setTranscribeMeetingsImpl({ data, context });
  });

export const setAppearance = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(setAppearanceSchema))
  .handler(async ({ data, context }) => {
    return setAppearanceImpl({ data, context });
  });

export const listSessions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return listSessionsImpl({ context });
  });

export const revokeSession = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(revokeSessionSchema))
  .handler(async ({ data, context }) => {
    return revokeSessionImpl({ data, context });
  });

export const revokeAllOtherSessions = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(stepUpBodySchema))
  .handler(async ({ data, context }) => {
    return revokeAllOtherSessionsImpl({ data, context });
  });

export const getDeletionPendingAccount = createServerFn({ method: "GET" })
  .middleware([accountDeletionAuthMiddleware])
  .handler(async ({ context }) => {
    return getDeletionPendingAccountImpl({ context });
  });

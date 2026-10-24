import { createServerFn } from "@tanstack/react-start";
import { accountDeletionAuthMiddleware } from "@/app/bootstrap/middleware";
import { serverInput } from "@/lib/validation";
import { deleteAccountSchema } from "@/modules/identity/contract/auth/schemas";
import { deleteAccountImpl } from "./delete-account.server";

export const deleteAccount = createServerFn({ method: "POST" })
  .middleware([accountDeletionAuthMiddleware])
  .validator(serverInput(deleteAccountSchema))
  .handler(async ({ data, context }) => {
    return deleteAccountImpl({ data, context });
  });

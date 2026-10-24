import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { serverInput } from "@/lib/validation";
import { deleteSpaceSchema } from "@/modules/spaces/contract/schemas";
import { deleteSpaceImpl } from "./delete-space.server";

export const deleteSpace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(deleteSpaceSchema))
  .handler(async ({ data, context }) => {
    return deleteSpaceImpl({ data, context });
  });

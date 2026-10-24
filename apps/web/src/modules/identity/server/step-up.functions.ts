import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import { stepUpRequestSchema } from "@/modules/identity/contract/auth/schemas";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { requestStepUpImpl } from "./step-up.server";

export const requestStepUp = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(stepUpRequestSchema))
  .handler(async ({ data, context }) => {
    return requestStepUpImpl({ data, context });
  });

import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import { beginEmailAuthSchema } from "@/modules/identity/contract/auth/schemas";
import { beginEmailAuthFlow } from "./begin-email-auth.server";

export const beginEmailAuth = createServerFn({ method: "POST" })
  .validator(serverInput(beginEmailAuthSchema))
  .handler(async ({ data }) => {
    return beginEmailAuthFlow(data);
  });

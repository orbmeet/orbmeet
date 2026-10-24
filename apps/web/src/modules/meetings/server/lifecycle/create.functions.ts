import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import { createMeetingSchema } from "@/modules/meetings/contract/schemas";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { createMeetingLinkImpl } from "./create.server";

export const createMeetingLink = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(createMeetingSchema))
  .handler(async ({ data, context }) => {
    return createMeetingLinkImpl({ data, context });
  });

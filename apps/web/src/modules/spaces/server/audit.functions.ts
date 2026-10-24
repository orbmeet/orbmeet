import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import { listAuditEventsSchema } from "@/modules/spaces/contract/schemas";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { listSpaceAuditEventsImpl } from "./audit.server";

export const listSpaceAuditEvents = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(listAuditEventsSchema))
  .handler(async ({ data, context }) => {
    return listSpaceAuditEventsImpl({ data, context });
  });

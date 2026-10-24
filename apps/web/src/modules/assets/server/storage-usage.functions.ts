import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { getMyStorageUsageImpl } from "./index.server";

export const getMyStorageUsage = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return getMyStorageUsageImpl({ context });
  });

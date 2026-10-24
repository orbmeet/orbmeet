import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { getMyThreadsImpl } from "./threads.server";

export const getMyThreads = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return getMyThreadsImpl({ context });
  });

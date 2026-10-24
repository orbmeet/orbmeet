import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { getMyLastReusableMeetingImpl } from "./last-reusable-meeting.server";

export const getMyLastReusableMeeting = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return getMyLastReusableMeetingImpl({ context });
  });

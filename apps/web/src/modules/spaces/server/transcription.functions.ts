import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import { setSpaceTranscriptionSchema } from "@/modules/spaces/contract/schemas";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { getPersonalSpaceTranscriptionImpl, setSpaceTranscriptionImpl } from "./transcription.server";

export const getPersonalSpaceTranscription = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return getPersonalSpaceTranscriptionImpl({ context });
  });

export const setSpaceTranscription = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(setSpaceTranscriptionSchema))
  .handler(async ({ data, context }) => {
    return setSpaceTranscriptionImpl({ data, context });
  });

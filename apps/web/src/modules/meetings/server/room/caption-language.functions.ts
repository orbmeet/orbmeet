import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import { requestMiddleware } from "@/app/bootstrap/middleware";
import * as v from "valibot";
import { idSchema } from "@orbmeet/public-api-contract/fields";
import { updateCaptionLanguageForRequest } from "./caption-language.server";

const updateCaptionLanguageSchema = v.object({
  meetingId: idSchema,
  connectionId: idSchema,
  language: v.pipe(v.string(), v.nonEmpty(), v.maxLength(35)),
});

export const updateCaptionLanguage = createServerFn({ method: "POST" })
  .validator(serverInput(updateCaptionLanguageSchema))
  .middleware([requestMiddleware])
  .handler(async ({ data, context }) => {
    return updateCaptionLanguageForRequest(data, context);
  });

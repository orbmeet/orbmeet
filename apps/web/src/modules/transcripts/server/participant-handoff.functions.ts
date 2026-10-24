import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import { requestMiddleware } from "@/app/bootstrap/middleware";
import * as v from "valibot";
import { idSchema } from "@orbmeet/public-api-contract/fields";
import { getParticipantHandoffSummaryImpl, getParticipantHandoffWhiteboardImpl } from "./participant-handoff.server";

const participantHandoffSchema = v.object({
  meetingId: idSchema,
  admissionId: idSchema,
});

const participantHandoffWhiteboardSchema = v.object({
  ...participantHandoffSchema.entries,
  whiteboardId: idSchema,
});

export const getParticipantHandoffSummary = createServerFn({ method: "POST" })
  .validator(serverInput(participantHandoffSchema))
  .middleware([requestMiddleware])
  .handler(async ({ data, context }) => {
    return getParticipantHandoffSummaryImpl({ data, context });
  });

export const getParticipantHandoffWhiteboard = createServerFn({ method: "POST" })
  .validator(serverInput(participantHandoffWhiteboardSchema))
  .middleware([requestMiddleware])
  .handler(async ({ data, context }) => {
    return getParticipantHandoffWhiteboardImpl({ data, context });
  });

export type ParticipantHandoffInput = v.InferOutput<typeof participantHandoffSchema>;
export type ParticipantHandoffWhiteboardInput = v.InferOutput<typeof participantHandoffWhiteboardSchema>;

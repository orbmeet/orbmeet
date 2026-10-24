import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import { idSchema, pageLimitSchema } from "@orbmeet/public-api-contract/fields";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { listMyOpenFollowUpsImpl, setFollowUpDoneImpl } from "./follow-ups.server";

const setFollowUpDoneSchema = v.object({ followUpId: idSchema, done: v.boolean() });
const listMyOpenFollowUpsSchema = v.object({ limit: pageLimitSchema(5, 20) });

/** Tick a follow-up off, or put it back. Anyone who can open its meeting may. */
export const setFollowUpDone = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(setFollowUpDoneSchema))
  .handler(async ({ data, context }) => {
    return setFollowUpDoneImpl({ data, context });
  });

/** Follow-ups not yet done from the viewer's recent meetings, newest meeting first. */
export const listMyOpenFollowUps = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(listMyOpenFollowUpsSchema))
  .handler(async ({ data, context }) => {
    return listMyOpenFollowUpsImpl({ data, context });
  });

export type SetFollowUpDoneInput = v.InferOutput<typeof setFollowUpDoneSchema>;
export type ListMyOpenFollowUpsInput = v.InferOutput<typeof listMyOpenFollowUpsSchema>;

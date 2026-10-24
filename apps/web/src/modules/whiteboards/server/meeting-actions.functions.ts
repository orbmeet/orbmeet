import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import {
  authMiddleware,
  preAuthRateLimitedRequestMiddleware,
  requestMiddleware,
} from "@/app/bootstrap/middleware";
import * as v from "valibot";
import { idSchema, integerSchema, timeZoneHintSchema } from "@orbmeet/public-api-contract/fields";
import { getWhiteboardTokenImpl, requestWhiteboardEditAccessImpl, grantWhiteboardEditAccessImpl, denyWhiteboardEditAccessImpl, setWhiteboardSurfaceStateImpl, setWhiteboardNavigationControllerImpl, releaseWhiteboardNavigationControllerImpl, recordWhiteboardPagePresentedImpl, recordWhiteboardPageEditImpl, addWhiteboardPageImpl, retryWhiteboardCaptureImpl } from "./meeting-actions.server";

const pageIdSchema = v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(128), v.startsWith("shape:"));

/**
 * Every in-meeting whiteboard action names its Meeting; a caller joined from a
 * specific connection also names that connection.
 */
const meetingActionEntries = {
  meetingId: idSchema,
  connectionId: v.optional(idSchema),
};
const meetingActionSchema = v.object(meetingActionEntries);

/**
 * An action on one board names it: the board the caller is looking at. The
 * server refuses it once the Meeting presents another, instead of applying it
 * to whichever board is presented now.
 */
const boardActionEntries = {
  ...meetingActionEntries,
  whiteboardId: idSchema,
};
const boardActionSchema = v.object(boardActionEntries);

const editAccessDecisionSchema = v.object({
  ...boardActionEntries,
  targetPrincipalKey: idSchema,
});

const retryWhiteboardCaptureSchema = v.object({ meetingId: idSchema });

const getWhiteboardTokenSchema = meetingActionSchema;
const requestWhiteboardEditAccessSchema = boardActionSchema;
const releaseWhiteboardNavigationControllerSchema = boardActionSchema;

const grantWhiteboardEditAccessSchema = editAccessDecisionSchema;
const denyWhiteboardEditAccessSchema = editAccessDecisionSchema;

const addWhiteboardPageSchema = v.object({
  ...boardActionEntries,
  afterPageNumber: v.optional(integerSchema(0)),
});

const recordWhiteboardPageEditSchema = v.object({
  ...boardActionEntries,
  pageId: pageIdSchema,
});

const recordWhiteboardPagePresentedSchema = v.object({
  ...boardActionEntries,
  pageId: pageIdSchema,
});

const setWhiteboardNavigationControllerSchema = v.object({
  ...boardActionEntries,
  targetUserId: idSchema,
});

const setWhiteboardSurfaceStateSchema = v.object({
  ...meetingActionEntries,
  open: v.boolean(),
  // Only used to name the Meeting's first untitled board after the day its
  // people are actually having. Never persisted against the user.
  clientTimeZone: v.optional(timeZoneHintSchema),
});

export const getWhiteboardToken = createServerFn({ method: "POST" })
  .validator(serverInput(getWhiteboardTokenSchema))
  .middleware([preAuthRateLimitedRequestMiddleware("whiteboard:token-preauth")])
  .handler(async ({ data, context }) => {
    return getWhiteboardTokenImpl({ data, context });
  });

export const requestWhiteboardEditAccess = createServerFn({ method: "POST" })
  .validator(serverInput(requestWhiteboardEditAccessSchema))
  .middleware([requestMiddleware])
  .handler(async ({ data, context }) => {
    return requestWhiteboardEditAccessImpl({ data, context });
  });

export const grantWhiteboardEditAccess = createServerFn({ method: "POST" })
  .validator(serverInput(grantWhiteboardEditAccessSchema))
  .middleware([requestMiddleware])
  .handler(async ({ data, context }) => {
    return grantWhiteboardEditAccessImpl({ data, context });
  });

export const denyWhiteboardEditAccess = createServerFn({ method: "POST" })
  .validator(serverInput(denyWhiteboardEditAccessSchema))
  .middleware([requestMiddleware])
  .handler(async ({ data, context }) => {
    return denyWhiteboardEditAccessImpl({ data, context });
  });

export const setWhiteboardSurfaceState = createServerFn({ method: "POST" })
  .validator(serverInput(setWhiteboardSurfaceStateSchema))
  .middleware([requestMiddleware])
  .handler(async ({ data, context }) => {
    return setWhiteboardSurfaceStateImpl({ data, context });
  });

export const setWhiteboardNavigationController = createServerFn({ method: "POST" })
  .validator(serverInput(setWhiteboardNavigationControllerSchema))
  .middleware([requestMiddleware])
  .handler(async ({ data, context }) => {
    return setWhiteboardNavigationControllerImpl({ data, context });
  });

export const releaseWhiteboardNavigationController = createServerFn({ method: "POST" })
  .validator(serverInput(releaseWhiteboardNavigationControllerSchema))
  .middleware([requestMiddleware])
  .handler(async ({ data, context }) => {
    return releaseWhiteboardNavigationControllerImpl({ data, context });
  });

export const recordWhiteboardPagePresented = createServerFn({ method: "POST" })
  .validator(serverInput(recordWhiteboardPagePresentedSchema))
  .middleware([requestMiddleware])
  .handler(async ({ data, context }) => {
    return recordWhiteboardPagePresentedImpl({ data, context });
  });

export const recordWhiteboardPageEdit = createServerFn({ method: "POST" })
  .validator(serverInput(recordWhiteboardPageEditSchema))
  .middleware([requestMiddleware])
  .handler(async ({ data, context }) => {
    return recordWhiteboardPageEditImpl({ data, context });
  });

export const addWhiteboardPage = createServerFn({ method: "POST" })
  .validator(serverInput(addWhiteboardPageSchema))
  .middleware([requestMiddleware])
  .handler(async ({ data, context }) => {
    return addWhiteboardPageImpl({ data, context });
  });

export const retryWhiteboardCapture = createServerFn({ method: "POST" })
  .validator(serverInput(retryWhiteboardCaptureSchema))
  .middleware([authMiddleware])
  .handler(async ({ data, context }) => {
    return retryWhiteboardCaptureImpl({ data, context });
  });

export type RetryWhiteboardCaptureInput = v.InferOutput<typeof retryWhiteboardCaptureSchema>;
export type GetWhiteboardTokenInput = v.InferOutput<typeof getWhiteboardTokenSchema>;
export type RequestWhiteboardEditAccessInput = v.InferOutput<typeof requestWhiteboardEditAccessSchema>;
export type ReleaseWhiteboardNavigationControllerInput = v.InferOutput<typeof releaseWhiteboardNavigationControllerSchema>;
export type GrantWhiteboardEditAccessInput = v.InferOutput<typeof grantWhiteboardEditAccessSchema>;
export type DenyWhiteboardEditAccessInput = v.InferOutput<typeof denyWhiteboardEditAccessSchema>;
export type AddWhiteboardPageInput = v.InferOutput<typeof addWhiteboardPageSchema>;
export type RecordWhiteboardPageEditInput = v.InferOutput<typeof recordWhiteboardPageEditSchema>;
export type RecordWhiteboardPagePresentedInput = v.InferOutput<typeof recordWhiteboardPagePresentedSchema>;
export type SetWhiteboardNavigationControllerInput = v.InferOutput<typeof setWhiteboardNavigationControllerSchema>;
export type SetWhiteboardSurfaceStateInput = v.InferOutput<typeof setWhiteboardSurfaceStateSchema>;

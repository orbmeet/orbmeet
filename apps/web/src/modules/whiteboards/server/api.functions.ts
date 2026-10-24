import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import { WHITEBOARD_STATUSES } from "@orbmeet/domain-model";
import { idSchema, pageLimitSchema, searchTextSchema, timeZoneHintSchema, trimmedText } from "@orbmeet/public-api-contract/fields";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { getWhiteboardImpl, listSpaceWhiteboardsImpl, listMyWhiteboardsImpl, listPresentableWhiteboardsImpl, setMeetingWhiteboardCopyPolicyImpl, presentWhiteboardImpl, createNewWhiteboardImpl, createWhiteboardImpl, listWhiteboardSnapshotsImpl, duplicateWhiteboardImpl, restoreWhiteboardSnapshotImpl, renameWhiteboardImpl, archiveWhiteboardImpl, restoreArchivedWhiteboardImpl, deleteArchivedWhiteboardImpl } from "./api.server";

const whiteboardListCursorSchema = v.object({
  updatedAt: v.pipe(v.number(), v.safeInteger()),
  id: idSchema,
});

const whiteboardPageEntries = {
  cursor: v.optional(whiteboardListCursorSchema),
  limit: pageLimitSchema(50),
};

const whiteboardTitleSchema = trimmedText(200);

const renameWhiteboardSchema = v.object({
  whiteboardId: idSchema,
  title: whiteboardTitleSchema,
});

const restoreWhiteboardSnapshotSchema = v.object({
  whiteboardId: idSchema,
  revisionId: idSchema,
});

const createSpaceWhiteboardSchema = v.strictObject({
  // Omitted means the user's own Space. The Whiteboards list spans every Space
  // the user belongs to, and a personal Space id is not something the client
  // has any business knowing — `meetings/server/lifecycle/create.server.ts` resolves it the same way.
  spaceId: v.nullish(idSchema),
  title: whiteboardTitleSchema,
});

const createMeetingWhiteboardSchema = v.object({
  meetingId: idSchema,
  // See `setWhiteboardSurfaceState`: a naming hint, not a stored preference.
  clientTimeZone: v.optional(timeZoneHintSchema),
});

const presentWhiteboardEntries = { meetingId: idSchema, whiteboardId: idSchema };

const presentWhiteboardSchema = v.object(presentWhiteboardEntries);

const meetingWhiteboardCopyPolicySchema = v.object({
  ...presentWhiteboardEntries,
  allowParticipantCopy: v.boolean(),
});

const meetingWhiteboardChoicesSchema = v.object({
  ...whiteboardPageEntries,
  meetingId: idSchema,
  search: v.optional(searchTextSchema),
});

const listMyWhiteboardsSchema = v.object({
  ...whiteboardPageEntries,
  status: v.picklist(WHITEBOARD_STATUSES),
});

const listWhiteboardsSchema = v.object({
  ...whiteboardPageEntries,
  spaceId: idSchema,
});

const whiteboardDocumentSchema = v.object({ whiteboardId: idSchema });

export const getWhiteboard = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(whiteboardDocumentSchema))
  .handler(async ({ data, context }) => {
    return getWhiteboardImpl({ data, context });
  });

export const listSpaceWhiteboards = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(listWhiteboardsSchema))
  .handler(async ({ data, context }) => {
    return listSpaceWhiteboardsImpl({ data, context });
  });

export const listMyWhiteboards = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(listMyWhiteboardsSchema))
  .handler(async ({ data, context }) => {
    return listMyWhiteboardsImpl({ data, context });
  });

export const listPresentableWhiteboards = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(meetingWhiteboardChoicesSchema))
  .handler(async ({ data, context }) => {
    return listPresentableWhiteboardsImpl({ data, context });
  });

export const setMeetingWhiteboardCopyPolicy = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(meetingWhiteboardCopyPolicySchema))
  .handler(async ({ data, context }) => {
    return setMeetingWhiteboardCopyPolicyImpl({ data, context });
  });

export const presentWhiteboard = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(presentWhiteboardSchema))
  .handler(async ({ data, context }) => {
    return presentWhiteboardImpl({ data, context });
  });

export const createNewWhiteboard = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(createMeetingWhiteboardSchema))
  .handler(async ({ data, context }) => {
    return createNewWhiteboardImpl({ data, context });
  });

export const createWhiteboard = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(createSpaceWhiteboardSchema))
  .handler(async ({ data, context }) => {
    return createWhiteboardImpl({ data, context });
  });

export const listWhiteboardSnapshots = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(whiteboardDocumentSchema))
  .handler(async ({ data, context }) => {
    return listWhiteboardSnapshotsImpl({ data, context });
  });

export const duplicateWhiteboard = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(whiteboardDocumentSchema))
  .handler(async ({ data, context }) => {
    return duplicateWhiteboardImpl({ data, context });
  });

export const restoreWhiteboardSnapshot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(restoreWhiteboardSnapshotSchema))
  .handler(async ({ data, context }) => {
    return restoreWhiteboardSnapshotImpl({ data, context });
  });

export const renameWhiteboard = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(renameWhiteboardSchema))
  .handler(async ({ data, context }) => {
    return renameWhiteboardImpl({ data, context });
  });

export const archiveWhiteboard = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(whiteboardDocumentSchema))
  .handler(async ({ data, context }) => {
    return archiveWhiteboardImpl({ data, context });
  });

export const restoreArchivedWhiteboard = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(whiteboardDocumentSchema))
  .handler(async ({ data, context }) => {
    return restoreArchivedWhiteboardImpl({ data, context });
  });

export const deleteArchivedWhiteboard = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(whiteboardDocumentSchema))
  .handler(async ({ data, context }) => {
    return deleteArchivedWhiteboardImpl({ data, context });
  });

export type WhiteboardListCursorInput = v.InferOutput<typeof whiteboardListCursorSchema>;
export type RenameWhiteboardInput = v.InferOutput<typeof renameWhiteboardSchema>;
export type RestoreWhiteboardSnapshotInput = v.InferOutput<typeof restoreWhiteboardSnapshotSchema>;
export type CreateSpaceWhiteboardInput = v.InferOutput<typeof createSpaceWhiteboardSchema>;
export type CreateMeetingWhiteboardInput = v.InferOutput<typeof createMeetingWhiteboardSchema>;
export type PresentWhiteboardInput = v.InferOutput<typeof presentWhiteboardSchema>;
export type MeetingWhiteboardCopyPolicyInput = v.InferOutput<typeof meetingWhiteboardCopyPolicySchema>;
export type MeetingWhiteboardChoicesInput = v.InferOutput<typeof meetingWhiteboardChoicesSchema>;
export type ListMyWhiteboardsInput = v.InferOutput<typeof listMyWhiteboardsSchema>;
export type ListWhiteboardsInput = v.InferOutput<typeof listWhiteboardsSchema>;
export type WhiteboardDocumentInput = v.InferOutput<typeof whiteboardDocumentSchema>;

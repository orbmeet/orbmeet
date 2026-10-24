import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import { idSchema, integerSchema } from "@orbmeet/public-api-contract/fields";
import { getWhiteboardUploadUrlImpl, finalizeWhiteboardUploadImpl } from "./uploads.server";

export const MAX_WHITEBOARD_FILE_SIZE = 25 * 1024 * 1024;
export const WHITEBOARD_ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** A connection is always a connection *to a meeting*. */
function namesMeetingForConnection(value: { meetingId?: string; connectionId?: string }): boolean {
  return value.meetingId !== undefined || value.connectionId === undefined;
}

const finalizeWhiteboardUploadSchema = v.pipe(
  v.object({
    action: v.picklist(["commit", "rollback"]),
    assetUrl: v.pipe(v.string(), v.nonEmpty(), v.maxLength(2048)),
    connectionId: v.optional(idSchema),
    meetingId: v.optional(idSchema),
    whiteboardId: idSchema,
  }),
  v.forward(
    v.partialCheck([["meetingId"], ["connectionId"]], namesMeetingForConnection, "connectionId requires meetingId"),
    ["connectionId"],
  ),
);

const whiteboardUploadSchema = v.pipe(
  v.object({
    filename: v.pipe(v.string(), v.nonEmpty(), v.maxLength(255)),
    // The browser reports any type; the server decides which it accepts.
    mimeType: v.pipe(
      v.string(),
      v.picklist(WHITEBOARD_ALLOWED_MIME_TYPES, `Whiteboard allowed types: ${WHITEBOARD_ALLOWED_MIME_TYPES.join(", ")}`),
    ),
    fileSize: integerSchema(1, MAX_WHITEBOARD_FILE_SIZE),
    whiteboardId: idSchema,
    md5Hash: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/i, "Invalid MD5 hash"))),
    connectionId: v.optional(idSchema),
    meetingId: v.optional(idSchema),
  }),
  v.forward(
    v.partialCheck([["meetingId"], ["connectionId"]], namesMeetingForConnection, "connectionId requires meetingId"),
    ["connectionId"],
  ),
);

export const getWhiteboardUploadUrl = createServerFn({ method: "POST" })
  .validator(serverInput(whiteboardUploadSchema))
  .handler(async ({ data }) => {
    return getWhiteboardUploadUrlImpl({ data });
  });

export const finalizeWhiteboardUpload = createServerFn({ method: "POST" })
  .validator(serverInput(finalizeWhiteboardUploadSchema))
  .handler(async ({ data }) => {
    return finalizeWhiteboardUploadImpl({ data });
  });

export type FinalizeWhiteboardUploadInput = v.InferOutput<typeof finalizeWhiteboardUploadSchema>;
export type WhiteboardUploadInput = v.InferOutput<typeof whiteboardUploadSchema>;

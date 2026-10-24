import { createServerFn } from "@tanstack/react-start";
import * as v from "valibot";
import { idSchema, integerSchema, trimmedText } from "@orbmeet/public-api-contract/fields";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { serverInput } from "@/lib/validation";
import { deleteFileSchema, getFileDownloadUrlSchema, listFilesSchema } from "@/modules/spaces/contract/schemas";
import {
  deleteFileImpl,
  finalizePdfFileUploadImpl,
  getFileDownloadUrlImpl,
  grantPdfFileUploadImpl,
  listFilesImpl,
  listInsertablePdfsImpl,
} from "./files.server";

export const MAX_SPACE_PDF_BYTES = 50 * 1024 * 1024;

const grantPdfFileUploadSchema = v.object({
  whiteboardId: idSchema,
  filename: trimmedText(255),
  fileSize: integerSchema(1, MAX_SPACE_PDF_BYTES),
});

const listInsertablePdfsValidator = v.object({ whiteboardId: idSchema });

const finalizePdfFileUploadValidator = v.object({
  whiteboardId: idSchema,
  assetId: idSchema,
  filename: trimmedText(255),
});

export const listInsertablePdfs = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(listInsertablePdfsValidator))
  .handler(async ({ data, context }) => {
    return listInsertablePdfsImpl({ data, context });
  });

export const listFiles = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(listFilesSchema))
  .handler(async ({ data, context }) => {
    return listFilesImpl({ data, context });
  });

export const getFileDownloadUrl = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(getFileDownloadUrlSchema))
  .handler(async ({ data, context }) => {
    return getFileDownloadUrlImpl({ data, context });
  });

export const deleteFile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(deleteFileSchema))
  .handler(async ({ data, context }) => {
    return deleteFileImpl({ data, context });
  });

export const grantPdfFileUpload = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(grantPdfFileUploadSchema))
  .handler(async ({ data, context }) => {
    return grantPdfFileUploadImpl({ data, context });
  });

export const finalizePdfFileUpload = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(finalizePdfFileUploadValidator))
  .handler(async ({ data, context }) => {
    return finalizePdfFileUploadImpl({ data, context });
  });

export type GrantPdfFileUploadInput = v.InferOutput<typeof grantPdfFileUploadSchema>;

export type ListInsertablePdfsInput = v.InferOutput<typeof listInsertablePdfsValidator>;

export type FinalizePdfFileUploadInput = v.InferOutput<typeof finalizePdfFileUploadValidator>;

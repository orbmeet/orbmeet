import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import * as v from "valibot";
import {
  createSpaceSchema,
  updateSpaceSchema,
  getSpaceSchema,
} from "@/modules/spaces/contract/schemas";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { createSpaceImpl, updateSpaceImpl, getSpaceImpl, getMySpacesImpl, getSpaceBySlugImpl } from "./crud.server";

const getSpaceBySlugValidator = v.object({ slug: v.pipe(v.string(), v.nonEmpty(), v.maxLength(200)) });

export const createSpace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(createSpaceSchema))
  .handler(async ({ data, context }) => {
    return createSpaceImpl({ data, context });
  });

export const updateSpace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(updateSpaceSchema))
  .handler(async ({ data, context }) => {
    return updateSpaceImpl({ data, context });
  });


export const getSpace = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(getSpaceSchema))
  .handler(async ({ data, context }) => {
    return getSpaceImpl({ data, context });
  });

export const getMySpaces = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return getMySpacesImpl({ context });
  });

export const getSpaceBySlug = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(getSpaceBySlugValidator))
  .handler(async ({ data, context }) => {
    return getSpaceBySlugImpl({ data, context });
  });

export type GetSpaceBySlugInput = v.InferOutput<typeof getSpaceBySlugValidator>;

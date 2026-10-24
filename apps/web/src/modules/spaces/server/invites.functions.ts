import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import {
  getSpaceInviteSchema,
  rotateSpaceInviteSchema,
  joinViaInviteSchema,
} from "@/modules/spaces/contract/schemas";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { getSpaceInviteImpl, rotateSpaceInviteImpl, previewInviteImpl, joinViaInviteImpl } from "./invites.server";

export const getSpaceInvite = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(getSpaceInviteSchema))
  .handler(async ({ data, context }) => {
    return getSpaceInviteImpl({ data, context });
  });

export const rotateSpaceInvite = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(rotateSpaceInviteSchema))
  .handler(async ({ data, context }) => {
    return rotateSpaceInviteImpl({ data, context });
  });

export const previewInvite = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(joinViaInviteSchema))
  .handler(async ({ data, context }) => {
    return previewInviteImpl({ data, context });
  });

export const joinViaInvite = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(joinViaInviteSchema))
  .handler(async ({ data, context }) => {
    return joinViaInviteImpl({ data, context });
  });

import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import {
  addMemberByEmailSchema,
  leaveSpaceSchema,
  listMembersSchema,
  removeMemberSchema,
  transferOwnershipSchema,
  updateMemberRoleSchema,
} from "@/modules/spaces/contract/schemas";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { listSpaceMembersImpl, addMemberByEmailImpl, removeMemberImpl, updateMemberRoleImpl, transferOwnershipImpl, leaveSpaceImpl } from "./membership.server";

export const listSpaceMembers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(listMembersSchema))
  .handler(async ({ data, context }) => {
    return listSpaceMembersImpl({ data, context });
  });

export const addMemberByEmail = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(addMemberByEmailSchema))
  .handler(async ({ data, context }) => {
    return addMemberByEmailImpl({ data, context });
  });

export const removeMember = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(removeMemberSchema))
  .handler(async ({ data, context }) => {
    return removeMemberImpl({ data, context });
  });

export const updateMemberRole = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(updateMemberRoleSchema))
  .handler(async ({ data, context }) => {
    return updateMemberRoleImpl({ data, context });
  });

export const transferOwnership = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(transferOwnershipSchema))
  .handler(async ({ data, context }) => {
    return transferOwnershipImpl({ data, context });
  });

export const leaveSpace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(leaveSpaceSchema))
  .handler(async ({ data, context }) => {
    return leaveSpaceImpl({ data, context });
  });

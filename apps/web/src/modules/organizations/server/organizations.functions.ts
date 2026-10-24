import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import {
  addOrganizationMemberSchema,
  createOrganizationSchema,
  getOrganizationSchema,
  listOrganizationMembersSchema,
  listOrganizationSpacesSchema,
  removeOrganizationMemberSchema,
  transferOrganizationOwnershipSchema,
} from "@/modules/organizations/contract/schemas";
import { authMiddleware } from "@/app/bootstrap/middleware";
import { createOrganizationImpl, getMyOrganizationsImpl, listOrganizationSpacesImpl } from "./organizations.server";
import { addOrganizationMemberImpl, listOrganizationMembersImpl, removeOrganizationMemberImpl } from "./membership.server";
import {
  acceptOrganizationOwnershipTransferImpl,
  declineOrganizationOwnershipTransferImpl,
  transferOrganizationOwnershipImpl,
} from "./ownership.server";

export const getMyOrganizations = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    return getMyOrganizationsImpl({ context });
  });

export const createOrganization = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(createOrganizationSchema))
  .handler(async ({ data, context }) => {
    return createOrganizationImpl({ data, context });
  });

export const listOrganizationMembers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(listOrganizationMembersSchema))
  .handler(async ({ data, context }) => {
    return listOrganizationMembersImpl({ data, context });
  });

export const listOrganizationSpaces = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(serverInput(listOrganizationSpacesSchema))
  .handler(async ({ data, context }) => {
    return listOrganizationSpacesImpl({ data, context });
  });

export const addOrganizationMember = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(addOrganizationMemberSchema))
  .handler(async ({ data, context }) => {
    return addOrganizationMemberImpl({ data, context });
  });

export const removeOrganizationMember = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(removeOrganizationMemberSchema))
  .handler(async ({ data, context }) => {
    return removeOrganizationMemberImpl({ data, context });
  });

export const transferOrganizationOwnership = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(transferOrganizationOwnershipSchema))
  .handler(async ({ data, context }) => {
    return transferOrganizationOwnershipImpl({ data, context });
  });

export const acceptOrganizationOwnershipTransfer = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(getOrganizationSchema))
  .handler(async ({ data, context }) => {
    return acceptOrganizationOwnershipTransferImpl({ data, context });
  });

export const declineOrganizationOwnershipTransfer = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverInput(getOrganizationSchema))
  .handler(async ({ data, context }) => {
    return declineOrganizationOwnershipTransferImpl({ data, context });
  });

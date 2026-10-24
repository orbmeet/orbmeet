import * as v from "valibot";
import { ORGANIZATION_MEMBER_ROLES } from "@orbmeet/domain-model";
import { emailSchema, idSchema, pageLimitSchema, trimmedText } from "@orbmeet/public-api-contract/fields";

export const createOrganizationSchema = v.object({
  name: trimmedText(200, "Name is required"),
});

export const getOrganizationSchema = v.object({
  organizationId: idSchema,
});

export const listOrganizationMembersSchema = v.object({
  organizationId: idSchema,
  limit: pageLimitSchema(50),
  // Opaque keyset cursor (`encodeTupleCursor`) from the previous page.
  cursor: v.optional(v.string()),
});

/** Listing an organization's Spaces names the organization, as reading it does. @alias */
export const listOrganizationSpacesSchema = getOrganizationSchema;

export const addOrganizationMemberSchema = v.object({
  organizationId: idSchema,
  email: emailSchema,
  role: v.optional(v.picklist(ORGANIZATION_MEMBER_ROLES), "member"),
});

export const removeOrganizationMemberSchema = v.object({
  organizationId: idSchema,
  memberUserId: idSchema,
});

export const transferOrganizationOwnershipSchema = v.object({
  organizationId: idSchema,
  newOwnerUserId: idSchema,
});

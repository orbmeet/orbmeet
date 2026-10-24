import * as v from "valibot";
import { emailSchema, idSchema, integerSchema, pageLimitSchema, timeZoneSchema, trimmedText } from "@orbmeet/public-api-contract/fields";
import { SPACE_MEMBERSHIP_ROLES } from "./types";

const spaceNameSchema = trimmedText(200, "Name is required");
const spaceDescriptionSchema = v.pipe(v.string(), v.maxLength(1000));

/** Every request that names only a Space. */
const spaceRefSchema = v.object({ spaceId: idSchema });

export const createSpaceSchema = v.object({
  name: spaceNameSchema,
  description: v.optional(spaceDescriptionSchema),
  organizationId: v.optional(idSchema),
  timeZone: v.optional(timeZoneSchema, "UTC"),
});

export const updateSpaceSchema = v.object({
  spaceId: idSchema,
  name: v.optional(trimmedText(200)),
  description: v.optional(spaceDescriptionSchema),
  timeZone: v.optional(timeZoneSchema),
  /** The values the editor started from, so a concurrent edit is not overwritten. */
  expected: v.object({
    name: v.pipe(v.string(), v.nonEmpty(), v.maxLength(200)),
    description: v.nullable(spaceDescriptionSchema),
    timeZone: timeZoneSchema,
  }),
});

export const addMemberByEmailSchema = v.object({
  spaceId: idSchema,
  email: emailSchema,
  role: v.optional(v.picklist(SPACE_MEMBERSHIP_ROLES), "member"),
});

export const joinViaInviteSchema = v.object({
  token: v.pipe(v.string(), v.nonEmpty(), v.maxLength(200)),
});

export const getSpaceSchema = spaceRefSchema;
export const deleteSpaceSchema = spaceRefSchema;
export const leaveSpaceSchema = spaceRefSchema;
export const getSpaceInviteSchema = spaceRefSchema;
export const rotateSpaceInviteSchema = spaceRefSchema;

const spaceMemberRefEntries = { spaceId: idSchema, userId: idSchema };

export const removeMemberSchema = v.object(spaceMemberRefEntries);
export const transferOwnershipSchema = v.object(spaceMemberRefEntries);

export const updateMemberRoleSchema = v.object({
  ...spaceMemberRefEntries,
  role: v.picklist(SPACE_MEMBERSHIP_ROLES),
});

export const listMembersSchema = v.object({
  spaceId: idSchema,
  limit: pageLimitSchema(50),
  // Opaque keyset cursor (`encodeTupleCursor`) from the previous page.
  cursor: v.optional(v.string()),
});

export const listFilesSchema = v.object({
  spaceId: idSchema,
  limit: pageLimitSchema(100, 200),
  /** The previous page's `nextCursor`. */
  cursor: v.optional(v.pipe(v.string(), v.maxLength(256))),
});

export const getFileDownloadUrlSchema = v.object({ fileId: idSchema });
export const deleteFileSchema = v.object({ fileId: idSchema });
export const getMeetingArtifactDownloadUrlSchema = v.object({ artifactId: idSchema });

export const listAuditEventsSchema = v.object({
  spaceId: idSchema,
  limit: pageLimitSchema(50),
  /** Keyset cursor: the createdAt (epoch ms) and id of the last row of the prior page. */
  cursor: v.optional(v.object({ createdAt: integerSchema(Number.MIN_SAFE_INTEGER), id: idSchema })),
});

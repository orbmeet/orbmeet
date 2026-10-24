import { ORGANIZATION_MEMBER_ROLES } from "@orbmeet/domain-model";

const ORGANIZATION_ROLES = ["owner", ...ORGANIZATION_MEMBER_ROLES] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

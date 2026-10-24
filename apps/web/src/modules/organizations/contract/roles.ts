import type { OrganizationRole } from "./types";

export type { OrganizationRole } from "./types";

const ORGANIZATION_ROLE_RANK: Record<OrganizationRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

export function hasMinOrganizationRole(role: OrganizationRole, min: OrganizationRole): boolean {
  return ORGANIZATION_ROLE_RANK[role] >= ORGANIZATION_ROLE_RANK[min];
}

export function canGrantOrganizationAdmin(role: OrganizationRole): boolean {
  return role === "owner";
}

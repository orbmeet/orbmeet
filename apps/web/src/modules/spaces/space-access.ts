import type { SpaceRole } from "@/modules/spaces/contract/types";

// These helpers label the viewer's *direct* Space membership — the content-access
// axis (see buildSpaceAccess in server/spaces/helpers.ts). Organization role is
// deliberately NOT an input: org owners/admins govern billing and may delete an
// org-funded Space, but that governance authority is not content membership and
// never reaches these surfaces (the Spaces list and the Space detail page both
// require canView, i.e. a direct space_members row). A viewer rendering a Space
// card or header therefore always has a non-null directRole.

export type SpaceAccessSummary = {
  directRole: SpaceRole | null;
};

export function getSpaceAccessLabel(access: SpaceAccessSummary): string {
  if (access.directRole === "owner") return "Owner";
  if (access.directRole === "admin") return "Admin";
  if (access.directRole === "member") return "Member";
  return "No access";
}

// Only organization billing is worth surfacing — a personal plan is the
// implicit default and reads as noise, so callers omit it.
export function getSpaceBillingLabel(organizationName: string | null | undefined): string | null {
  return organizationName ? `Billed to ${organizationName}` : null;
}

export function getSpaceAccessLevel(
  access: SpaceAccessSummary,
): "owner" | "admin" | "member" {
  if (access.directRole === "owner") {
    return "owner";
  }
  if (access.directRole === "admin") {
    return "admin";
  }
  return "member";
}

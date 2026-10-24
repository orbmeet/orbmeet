import type { SpaceRole } from "@/modules/spaces/contract/types";

/**
 * Maps a space role to its Badge variant. Shared so every space surface
 * (cards, header, member rows, dashboard widget) renders the same role the
 * same way instead of each file re-declaring the mapping.
 */
export const spaceRoleBadgeVariant: Record<SpaceRole, "primary" | "warning" | "default"> = {
  owner: "primary",
  admin: "warning",
  member: "default",
};

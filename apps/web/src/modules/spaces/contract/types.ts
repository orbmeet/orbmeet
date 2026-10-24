import {
  SPACE_MEMBERSHIP_ROLES,
  type SpaceAuditAction,
  type SpaceMembershipRole,
  type SpaceRole,
} from "@orbmeet/domain-model";

export {
  SPACE_MEMBERSHIP_ROLES,
  type SpaceAuditAction,
  type SpaceMembershipRole,
  type SpaceRole,
};

export interface SpaceMemberSummary {
  id: string;
  userId: string;
  role: SpaceRole;
  joinedAt: Date;
  user: { id: string; name: string; image: string | null } | null;
}

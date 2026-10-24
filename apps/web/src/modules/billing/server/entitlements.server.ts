import "@tanstack/react-start/server-only";
import type { Database } from "@orbmeet/db";
import { organizations, spaces, users } from "@orbmeet/db/schema";
import { eq } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { getPlanLimits, type PlanLimits } from "@/modules/billing/contract/plan-limits";
import type { SubscriptionTier } from "@/modules/billing/contract/types";

// Entitlement resolution shared by serverFns, webhooks, and cron maintenance,
// for every module that enforces plan limits: Meetings, files, Whiteboards.

export interface MeetingEntitlementRecord {
  startedByUserId?: string | null;
  spaceId: string;
  billingPlan?: SubscriptionTier | string | null;
  billingPrincipalType?: "user" | "organization" | null;
  billingPrincipalId?: string | null;
}

export interface MeetingEntitlement {
  plan: SubscriptionTier;
  limits: PlanLimits;
  /**
   * The user account charged for storage: the principal itself for
   * user-billed meetings, the organization's current owner otherwise. Derived
   * here — the meeting row stores only the principal tuple.
   */
  billingUserId: string;
  billingPrincipal: { type: "user" | "organization"; id: string };
  source: "meeting-snapshot" | "space-owner" | "organization";
}

export function normalizePlan(
  plan: SubscriptionTier | string | null | undefined,
): SubscriptionTier {
  if (plan === "pro" || plan === "organization") return plan;
  return "free";
}

/**
 * The immutable billing snapshot on the meeting row, when present. For an
 * organization principal the storage-charged user (the org's current owner)
 * is resolved by the caller — this stays join-free.
 */
function snapshottedMeetingPrincipal(
  meeting: MeetingEntitlementRecord,
): { plan: SubscriptionTier; principal: { type: "user" | "organization"; id: string } } | null {
  if (!meeting.billingPrincipalType || !meeting.billingPrincipalId || !meeting.billingPlan) {
    return null;
  }
  return {
    plan: normalizePlan(meeting.billingPlan),
    principal: { type: meeting.billingPrincipalType, id: meeting.billingPrincipalId },
  };
}

function snapshotEntitlement(
  snapshot: NonNullable<ReturnType<typeof snapshottedMeetingPrincipal>>,
  billingUserId: string,
): MeetingEntitlement {
  return {
    plan: snapshot.plan,
    limits: getPlanLimits(snapshot.plan),
    billingUserId,
    billingPrincipal: snapshot.principal,
    source: "meeting-snapshot",
  };
}

interface SpaceEntitlementRow {
  ownerUserId: string | null;
  ownerName?: string | null;
  ownerPlan: SubscriptionTier | string | null;
  organizationId: string | null;
  organizationName?: string | null;
  organizationOwnerId: string | null;
  organizationPlan: SubscriptionTier | string | null;
}

/**
 * Plan precedence for a Space: its Organization plan wins over the personal
 * Space owner's plan. Single source of truth, shared by the per-Space and batch
 * resolvers and the creation-entitlement server fn (the latter keeps the
 * billing display name).
 */
function entitlementFromSpaceRow(
  row: SpaceEntitlementRow,
): MeetingEntitlement & { billingName: string } {
  if (row.organizationId && row.organizationOwnerId) {
    const plan = normalizePlan(row.organizationPlan);
    return {
      plan,
      limits: getPlanLimits(plan),
      billingUserId: row.organizationOwnerId,
      billingPrincipal: { type: "organization", id: row.organizationId },
      source: "organization",
      billingName: row.organizationName ?? "Organization",
    };
  }
  if (!row.ownerUserId) {
    throw Errors.VALIDATION("Space is missing its owner");
  }
  const plan = normalizePlan(row.ownerPlan);
  return {
    plan,
    limits: getPlanLimits(plan),
    billingUserId: row.ownerUserId,
    billingPrincipal: { type: "user", id: row.ownerUserId },
    source: "space-owner",
    billingName: row.ownerName ?? "Space owner",
  };
}

const spaceEntitlementColumns = {
  ownerUserId: spaces.ownerUserId,
  ownerName: users.name,
  ownerPlan: users.plan,
  organizationId: spaces.organizationId,
  organizationName: organizations.name,
  organizationOwnerId: organizations.ownerId,
  organizationPlan: organizations.plan,
} as const;

export async function loadSpaceEntitlement(
  db: Database,
  spaceId: string,
): Promise<MeetingEntitlement & { billingName: string }> {
  const [row] = await db
    .select(spaceEntitlementColumns)
    .from(spaces)
    .leftJoin(users, eq(users.id, spaces.ownerUserId))
    .leftJoin(organizations, eq(organizations.id, spaces.organizationId))
    .where(eq(spaces.id, spaceId))
    .limit(1);

  if (!row) throw Errors.NOT_FOUND("Space");
  return entitlementFromSpaceRow(row);
}

export async function resolveMeetingEntitlement(
  db: Database,
  meeting: MeetingEntitlementRecord,
): Promise<MeetingEntitlement> {
  const snapshot = snapshottedMeetingPrincipal(meeting);
  if (snapshot) {
    if (snapshot.principal.type === "user") {
      return snapshotEntitlement(snapshot, snapshot.principal.id);
    }
    const organization = await db.query.organizations.findFirst({
      where: { id: snapshot.principal.id },
      columns: { ownerId: true },
    });
    // A deleted organization falls through to the Space as the current
    // billing authority.
    if (organization) return snapshotEntitlement(snapshot, organization.ownerId);
  }

  const { billingName: _billingName, ...entitlement } = await loadSpaceEntitlement(db, meeting.spaceId);
  return entitlement;
}

import "@tanstack/react-start/server-only";
import type { Database } from "@orbmeet/db";
import { billingSubscriptions, organizationMembers, organizations, spaces, users } from "@orbmeet/db/schema";
import { Column, eq, getColumnTable, getTableName, is, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { Errors } from "@/lib/app-errors";
import { getPlanLimits, type PlanLimits } from "@/modules/billing/contract/plan-limits";
import { ENDED_SUBSCRIPTION_STATUS, ENTITLED_SUBSCRIPTION_STATUSES } from "@/modules/billing/contract/subscription";
import type { SubscriptionStatus, SubscriptionTier } from "@/modules/billing/contract/types";

// Entitlement resolution shared by serverFns, webhooks, and cron maintenance,
// for every module that enforces plan limits: Meetings, files, Whiteboards.
//
// Plans are derived, never stored: a user is on Pro while one of their
// subscriptions grants entitlements, an Organization is on the Organization
// plan while one of its own does, and everything else is Free. The SQL below
// is the one definition of that rule; statement-level guards embed it so a
// plan read before a write cannot go stale inside it.

const entitledStatuses = sql.raw(ENTITLED_SUBSCRIPTION_STATUSES.map((status) => `'${status}'`).join(", "));

/**
 * A customer id for the correlated subqueries below. Drizzle leaves the table
 * name off a column in a single-table query, and an unqualified `"id"` inside
 * a subquery over `billing_subscriptions` would bind to that table's own id,
 * so a column is always written out as `"table"."column"`.
 */
function customerRef(value: SQLWrapper | string): SQLWrapper | string {
  return is(value, Column)
    ? sql`${sql.identifier(getTableName(getColumnTable(value)))}.${sql.identifier(value.name)}`
    : value;
}

/** `'pro'` or `'free'`: the plan of the user whose id `userId` evaluates to. */
export function userPlanSql(userId: SQLWrapper | string): SQL<"pro" | "free"> {
  return sql<"pro" | "free">`(case when exists (
    select 1 from ${billingSubscriptions} entitled_user_subscription
    where entitled_user_subscription.user_id = ${customerRef(userId)}
      and entitled_user_subscription.status in (${entitledStatuses})
  ) then 'pro' else 'free' end)`;
}

/** `'organization'` or `'free'`: the plan of the Organization `organizationId` names. */
export function organizationPlanSql(organizationId: SQLWrapper | string): SQL<"organization" | "free"> {
  return sql<"organization" | "free">`(case when exists (
    select 1 from ${billingSubscriptions} entitled_organization_subscription
    where entitled_organization_subscription.organization_id = ${customerRef(organizationId)}
      and entitled_organization_subscription.status in (${entitledStatuses})
  ) then 'organization' else 'free' end)`;
}

/**
 * True while the Organization is entitled and pays for more seats than it has
 * members: the guard every statement that adds a member embeds.
 */
export function organizationHasOpenSeatSql(organizationId: string): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from ${billingSubscriptions} seat_subscription
    where seat_subscription.organization_id = ${organizationId}
      and seat_subscription.status in (${entitledStatuses})
      and seat_subscription.seats > (
        select count(*) from ${organizationMembers} seated_member
        where seated_member.organization_id = ${organizationId}
      )
  )`;
}

/** The subscription a customer manages: the newest one that has not ended. */
function liveSubscriptionSql<T>(column: SQL, customerColumn: SQL, customerId: SQLWrapper | string): SQL<T | null> {
  return sql<T | null>`(
    select ${column} from ${billingSubscriptions} live_subscription
    where ${customerColumn} = ${customerRef(customerId)} and live_subscription.status <> ${ENDED_SUBSCRIPTION_STATUS}
    order by live_subscription.source_version desc limit 1
  )`;
}

/**
 * A user's own billing, as a selection to embed in any query over `users`:
 * their plan, the status of the subscription they manage (null when none is
 * running), and whether there is one, which sends them to the billing portal
 * rather than to a checkout.
 */
export function userBillingSelection(userId: SQLWrapper | string) {
  const status = liveSubscriptionSql<Exclude<SubscriptionStatus, null>>(
    sql`live_subscription.status`,
    sql`live_subscription.user_id`,
    userId,
  );
  return {
    plan: userPlanSql(userId),
    subscriptionStatus: status,
    hasManagedSubscription: sql<boolean>`(${status} is not null)`.mapWith(Boolean),
  };
}

export interface UserBilling {
  plan: "pro" | "free";
  subscriptionStatus: SubscriptionStatus;
  hasManagedSubscription: boolean;
}

export const FREE_USER_BILLING: UserBilling = {
  plan: "free",
  subscriptionStatus: null,
  hasManagedSubscription: false,
};

export async function loadUserBilling(db: Database, userId: string): Promise<UserBilling> {
  const [row] = await db.select(userBillingSelection(users.id)).from(users).where(eq(users.id, userId)).limit(1);
  return row ?? FREE_USER_BILLING;
}

/** An Organization's billing, as a selection to embed in any query over `organizations`. */
export function organizationBillingSelection(organizationId: SQLWrapper | string) {
  const live = <T>(column: string) =>
    liveSubscriptionSql<T>(sql.raw(`live_subscription.${column}`), sql`live_subscription.organization_id`, organizationId);
  return {
    plan: organizationPlanSql(organizationId),
    subscriptionStatus: live<Exclude<SubscriptionStatus, null>>("status"),
    seats: live<number>("seats"),
    cancelAtPeriodEnd: sql<boolean | null>`${live<number>("cancel_at_period_end")}`.mapWith((value) => value === null ? null : Boolean(value)),
    currentPeriodEnd: sql<Date | null>`${live<number>("current_period_end")}`.mapWith((value) => value === null ? null : new Date(Number(value))),
  };
}

export async function loadOrganizationPlan(
  db: Database,
  organizationId: string,
): Promise<"organization" | "free"> {
  const [row] = await db
    .select({ plan: organizationPlanSql(organizations.id) })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.plan ?? "free";
}

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
  ownerPlan: userPlanSql(spaces.ownerUserId),
  organizationId: spaces.organizationId,
  organizationName: organizations.name,
  organizationOwnerId: organizations.ownerId,
  organizationPlan: organizationPlanSql(spaces.organizationId),
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

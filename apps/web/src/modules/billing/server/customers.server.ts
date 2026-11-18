import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { logError } from "@/lib/logger";
import type { BillingCustomer } from "@/modules/billing/contract/types";
import { customerExternalId, memberExternalId } from "./customer-ids";
import {
  createIndividualCustomer,
  createMember,
  createTeamCustomer,
  deleteMember,
  findCustomerByEmail,
  getCustomerByExternalId,
  getMember,
  listMembers,
  makeMemberOwner,
  polarClientFromEnv,
  setCustomerExternalId,
  type PolarClient,
} from "./polar";

/**
 * Our customers at Polar. Each is created before its first checkout, so the
 * checkout is linked to it by id (which also locks the email on Polar's page).
 */

export type EnsuredCustomer =
  | { kind: "ready"; polarCustomerId: string }
  | { kind: "email_taken" }
  | { kind: "not_found" };

interface Person {
  id: string;
  email: string;
  name: string;
}

/**
 * Make the Organization's owner the only member of its team customer, so
 * billing mail reaches them, the portal opens as them, and a previous owner's
 * email does not stay at Polar. Idempotent.
 */
async function ensureOwnerMember(client: PolarClient, organizationId: string, owner: Person): Promise<void> {
  const customerId = customerExternalId({ kind: "organization", organizationId });
  const memberId = memberExternalId(owner.id);
  const member = await getMember(client, customerId, memberId);
  if (!member) await createMember(client, customerId, { externalId: memberId, email: owner.email, name: owner.name });
  if (member?.role !== "owner") await makeMemberOwner(client, customerId, memberId);
  for (const other of await listMembers(client, customerId)) {
    if (other.external_id && other.external_id !== memberId) await deleteMember(client, customerId, other.external_id);
  }
}

async function loadOrganizationWithOwner(db: Database, organizationId: string) {
  const organization = await db.query.organizations.findFirst({
    where: { id: organizationId },
    columns: { id: true, name: true, ownerId: true },
  });
  if (!organization) return null;
  const owner = await db.query.users.findFirst({
    where: { id: organization.ownerId },
    columns: { id: true, email: true, name: true },
  });
  return owner ? { organization, owner } : null;
}

/**
 * The Polar customer for one of ours, created if it does not exist yet.
 *
 * A person may already be a Polar customer by email with no external id (a
 * dashboard sale, a checkout link): that customer is claimed, as Polar's own
 * auth integrations do, so their history stays in one place. One carrying a
 * different external id belongs to another account and is never taken over.
 */
export async function ensurePolarCustomer(
  db: Database,
  client: PolarClient,
  customer: BillingCustomer,
): Promise<EnsuredCustomer> {
  const externalId = customerExternalId(customer);

  if (customer.kind === "user") {
    const user = await db.query.users.findFirst({
      where: { id: customer.userId },
      columns: { id: true, email: true, name: true, deletionStartedAt: true },
    });
    if (!user || user.deletionStartedAt) return { kind: "not_found" };
    const existing = await getCustomerByExternalId(client, externalId);
    if (existing) return { kind: "ready", polarCustomerId: existing.id };
    const holder = await findCustomerByEmail(client, user.email);
    if (!holder) {
      const created = await createIndividualCustomer(client, { externalId, email: user.email, name: user.name });
      return { kind: "ready", polarCustomerId: created.id };
    }
    if (holder.external_id) return { kind: "email_taken" };
    await setCustomerExternalId(client, holder.id, externalId);
    return { kind: "ready", polarCustomerId: holder.id };
  }

  const loaded = await loadOrganizationWithOwner(db, customer.organizationId);
  if (!loaded) return { kind: "not_found" };
  const { organization, owner } = loaded;
  const existing = await getCustomerByExternalId(client, externalId);
  if (existing) {
    await ensureOwnerMember(client, organization.id, owner);
    return { kind: "ready", polarCustomerId: existing.id };
  }
  const created = await createTeamCustomer(client, {
    externalId,
    name: organization.name,
    owner: { externalId: memberExternalId(owner.id), email: owner.email, name: owner.name },
  });
  return { kind: "ready", polarCustomerId: created.id };
}

/**
 * After an ownership transfer: point the Organization's Polar customer at its
 * new owner. Opening the portal does the same, so a failure here only delays
 * billing mail reaching the new owner; it is logged, never thrown.
 */
export async function syncOrganizationBillingOwner(
  db: Database,
  env: { POLAR_ACCESS_TOKEN?: string; POLAR_SERVER?: string },
  organizationId: string,
): Promise<void> {
  const client = polarClientFromEnv(env);
  if (!client) return;
  try {
    const loaded = await loadOrganizationWithOwner(db, organizationId);
    if (!loaded) return;
    const existing = await getCustomerByExternalId(
      client,
      customerExternalId({ kind: "organization", organizationId }),
    );
    // Never subscribed: the customer is created with the right owner later.
    if (!existing) return;
    await ensureOwnerMember(client, organizationId, loaded.owner);
  } catch (error) {
    logError("[billing] Could not move the Organization's billing owner", { organizationId }, error);
  }
}

/** The owner member a team customer's portal opens as. */
export async function prepareOrganizationPortalMember(
  db: Database,
  client: PolarClient,
  organizationId: string,
): Promise<string | null> {
  const loaded = await loadOrganizationWithOwner(db, organizationId);
  if (!loaded) return null;
  await ensureOwnerMember(client, organizationId, loaded.owner);
  return memberExternalId(loaded.owner.id);
}

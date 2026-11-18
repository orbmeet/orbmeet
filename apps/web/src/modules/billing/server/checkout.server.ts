import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { organizationMembers } from "@orbmeet/db/schema";
import { count, eq } from "drizzle-orm";
import type { SerialResults, SerialTask } from "@/app/serial/serial";
import { logError } from "@/lib/logger";
import { planForCustomer, type BillingCustomer } from "@/modules/billing/contract/types";
import {
  CHECKOUT_RETURN_ORGANIZATION_PARAM,
  CHECKOUT_RETURN_PARAM,
} from "@/modules/billing/contract/checkout-return";
import { customerExternalId } from "./customer-ids";
import { ensurePolarCustomer, prepareOrganizationPortalMember } from "./customers.server";
import { createCheckout, createPortalSession, getCustomerByExternalId, polarClientFromEnv } from "./polar";
import { polarProductIdForPlan, type PolarCatalogConfig } from "./polar-config";
import { findLiveSubscriptionId } from "./subscription-store.server";

type CheckoutEnv = PolarCatalogConfig & Pick<Env, "POLAR_ACCESS_TOKEN" | "POLAR_SERVER" | "APP_URL">;

/** Where Polar sends the customer back to, on success or by its back button. */
function billingSettingsUrl(appUrl: string): string {
  return `${appUrl}/settings?tab=${encodeURIComponent("plan-&-billing")}`;
}

/**
 * Where a completed checkout lands: Settings, marked with the checkout and,
 * for an Organization, which one, so the page knows whose subscription to
 * wait for. Polar substitutes the literal `{CHECKOUT_ID}`; URLSearchParams
 * would percent-encode the braces out of recognition.
 */
function checkoutReturnUrl(appUrl: string, customer: BillingCustomer): string {
  const organization = customer.kind === "organization"
    ? `&${CHECKOUT_RETURN_ORGANIZATION_PARAM}=${encodeURIComponent(customer.organizationId)}`
    : "";
  return `${billingSettingsUrl(appUrl)}${organization}&${CHECKOUT_RETURN_PARAM}={CHECKOUT_ID}`;
}

/** Whether `actorUserId` manages this customer's billing: the person, or the Organization's owner. */
async function managesBilling(db: Database, customer: BillingCustomer, actorUserId: string): Promise<boolean> {
  if (customer.kind === "user") return customer.userId === actorUserId;
  const organization = await db.query.organizations.findFirst({
    where: { id: customer.organizationId },
    columns: { ownerId: true },
  });
  return organization?.ownerId === actorUserId;
}

/**
 * A hosted Polar checkout for a customer's plan. Runs in the customer's serial
 * scope, so two requests never race to create its Polar customer.
 *
 * A checkout session is free and expires on its own, so every request gets a
 * fresh one. What keeps a customer from paying twice is Polar, which allows
 * one active subscription per customer; the local gate spares them a checkout
 * Polar would refuse and sends them to the portal instead.
 */
export async function prepareCheckout(
  db: Database,
  env: CheckoutEnv,
  task: Extract<SerialTask, { kind: "prepareCheckout" }>,
): Promise<SerialResults["prepareCheckout"]> {
  const { customer } = task;
  const client = polarClientFromEnv(env);
  const productId = polarProductIdForPlan(env, planForCustomer(customer));
  if (!client || !productId) throw new Error("Polar checkout is not configured");
  if (!(await managesBilling(db, customer, task.actorUserId))) return { kind: "forbidden" };

  if (await findLiveSubscriptionId(db, customer)) return { kind: "subscription_exists" };

  const polarCustomer = await ensurePolarCustomer(db, client, customer);
  if (polarCustomer.kind === "not_found") return { kind: "not_found" };
  if (polarCustomer.kind === "email_taken") {
    logError("[billing] Checkout email belongs to a Polar customer linked to another account", {
      userId: task.actorUserId,
    });
    return { kind: "email_taken" };
  }

  // An Organization pays per member: checkout sells exactly the members it has.
  let seats: number | undefined;
  if (customer.kind === "organization") {
    const [{ value = 0 } = {}] = await db
      .select({ value: count() })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, customer.organizationId));
    seats = Math.max(1, value);
  }

  const url = await createCheckout(client, {
    customerId: polarCustomer.polarCustomerId,
    productId,
    seats,
    successUrl: checkoutReturnUrl(env.APP_URL, customer),
    returnUrl: billingSettingsUrl(env.APP_URL),
    customerIpAddress: task.customerIpAddress ?? undefined,
  });
  return { kind: "checkout", url };
}

export type PortalResult =
  | { kind: "portal"; url: string }
  | { kind: "no_billing_account" }
  | { kind: "forbidden" };

/** A pre-authenticated Polar portal link for a customer that has bought before. */
export async function openBillingPortal(
  db: Database,
  env: CheckoutEnv,
  input: { customer: BillingCustomer; actorUserId: string },
): Promise<PortalResult> {
  const { customer } = input;
  const client = polarClientFromEnv(env);
  if (!client) throw new Error("Polar is not configured");
  if (!(await managesBilling(db, customer, input.actorUserId))) return { kind: "forbidden" };

  const externalId = customerExternalId(customer);
  if (!(await getCustomerByExternalId(client, externalId))) return { kind: "no_billing_account" };
  const memberExternalId = customer.kind === "organization"
    ? await prepareOrganizationPortalMember(db, client, customer.organizationId)
    : undefined;
  if (memberExternalId === null) return { kind: "no_billing_account" };

  const url = await createPortalSession(client, {
    customerExternalId: externalId,
    memberExternalId,
    returnUrl: billingSettingsUrl(env.APP_URL),
  });
  return { kind: "portal", url };
}

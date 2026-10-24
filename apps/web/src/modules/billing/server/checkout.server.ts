import "@tanstack/react-start/server-only";

import type { Database } from "@orbmeet/db";
import { organizationMembers, users } from "@orbmeet/db/schema";
import { and, count, eq, isNull } from "drizzle-orm";
import { getRunChanges } from "@/platform/database/db-utils";
import type { SerialResults, SerialTask } from "@/app/serial/serial";
import { hasManagedPaddleSubscription } from "@/modules/billing/contract/subscription";
import { configuredPaddlePriceId } from "./paddle-config";
import {
  createCheckoutTransaction,
  getOrCreatePaddleCustomer,
  resolveCheckoutTransaction,
} from "./paddle";

/**
 * The Paddle transaction a user's checkout pays for: the one already open for
 * this exact plan and quantity, or a new one. Runs in the user's serial scope,
 * so two requests from one user never mint two payable transactions.
 */
export async function preparePaddleCheckout(
  db: Database,
  env: Pick<Env, "PADDLE_API_KEY" | "PADDLE_PRICE_ID_PRO" | "PADDLE_PRICE_ID_ORG_SEAT">,
  task: Extract<SerialTask, { kind: "preparePaddleCheckout" }>,
): Promise<SerialResults["preparePaddleCheckout"]> {
  const apiKey = env.PADDLE_API_KEY;
  const priceId = configuredPaddlePriceId(
    task.plan === "pro" ? env.PADDLE_PRICE_ID_PRO : env.PADDLE_PRICE_ID_ORG_SEAT,
  );
  if (!apiKey || !priceId) throw new Error("Paddle checkout is not configured");

  const user = await db.query.users.findFirst({
    where: { id: task.userId },
    columns: {
      id: true,
      email: true,
      name: true,
      paddleCustomerId: true,
      paddleSubscriptionId: true,
      subscriptionStatus: true,
    },
  });
  if (!user) return { kind: "not_found" };
  if (
    hasManagedPaddleSubscription({
      subscriptionId: user.paddleSubscriptionId,
      subscriptionStatus: user.subscriptionStatus,
    })
  ) {
    return { kind: "subscription_exists" };
  }

  let customerId = user.paddleCustomerId;
  if (!customerId) {
    const resolvedCustomerId = await getOrCreatePaddleCustomer(apiKey, user.email, user.name);
    const update = await db
      .update(users)
      .set({ paddleCustomerId: resolvedCustomerId, updatedAt: new Date() })
      .where(and(eq(users.id, user.id), isNull(users.paddleCustomerId)));
    if (getRunChanges(update) > 0) {
      customerId = resolvedCustomerId;
    } else {
      customerId =
        (
          await db.query.users.findFirst({
            where: { id: user.id },
            columns: { paddleCustomerId: true },
          })
        )?.paddleCustomerId ?? resolvedCustomerId;
    }
  }

  let quantity = 1;
  if (task.plan === "organization") {
    const organization = await db.query.organizations.findFirst({
      where: { ownerId: user.id },
      columns: { id: true },
    });
    if (organization) {
      const [{ value = 0 } = {}] = await db
        .select({ value: count() })
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, organization.id));
      quantity = Math.max(1, value);
    }
  }

  // Hand back the checkout this user already has open for this exact plan and
  // quantity, rather than creating a second payable transaction for the same
  // purchase. resolveCheckoutTransaction also re-reads Paddle's own
  // subscription list first — our local projection can lag a payment that has
  // already settled into a subscription there, and Paddle can collect it from
  // a saved payment method.
  const resolution = await resolveCheckoutTransaction(apiKey, { customerId, priceId, quantity });
  if (resolution.state === "open") return { kind: "transaction", transactionId: resolution.transactionId };
  if (resolution.state === "pending") return { kind: "pending" };
  const transactionId = await createCheckoutTransaction(apiKey, { customerId, priceId, quantity });
  return { kind: "transaction", transactionId };
}

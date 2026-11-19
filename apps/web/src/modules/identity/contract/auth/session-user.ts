import type { APPEARANCES } from "@orbmeet/domain-model";
import type { SubscriptionStatus, SubscriptionTier } from "@/modules/billing/contract/types";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  timeZone: string | null;
  /** Light, dark, or the device's own setting. */
  appearance: (typeof APPEARANCES)[number];
  /** The person's own plan. An Organization's plan applies to its Spaces only. */
  plan: Extract<SubscriptionTier, "free" | "pro">;
  role: "admin" | "user";
  /** Their running subscription's status; null when none is running. */
  subscriptionStatus: SubscriptionStatus;
  /** A subscription is running: billing is managed in the portal, not bought again. */
  hasManagedSubscription: boolean;
}

export type AuthenticatedUser = SessionUser;

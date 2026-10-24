import type { APPEARANCES } from "@orbmeet/domain-model";
import type { SubscriptionStatus, SubscriptionTier } from "@/modules/billing/contract/types";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  timeZone: string | null;
  /** Whether meetings this user starts begin with transcription on. */
  transcribeMeetings: boolean;
  /** Light, dark, or the device's own setting. */
  appearance: (typeof APPEARANCES)[number];
  plan: SubscriptionTier;
  role: "admin" | "user";
  subscriptionStatus: SubscriptionStatus;
  hasManagedSubscription: boolean;
}

export type AuthenticatedUser = SessionUser;

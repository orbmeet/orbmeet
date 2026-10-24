import { getPlanLimits, type SubscriptionTier } from "@/modules/billing/contract/plan-limits";

export function reusableLinkCreationInput(plan: SubscriptionTier, code: string) {
  const limits = getPlanLimits(plan);
  return {
    allowGuests: true,
    joinPolicy: "open" as const,
    linkType: "reusable" as const,
    ...(limits.customPersonalMeetingCode ? { customCode: code } : {}),
  };
}

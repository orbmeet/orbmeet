import { motion, row } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { ExternalLink } from "lucide-react";
import * as React from "react";

import { settings } from "../settings-styles";

const styles = stylex.create({
  statusBadge: { textTransform: "capitalize" },
  summary: { marginTop: space.s2, marginBottom: 0 },
  /** The limits table: two columns of label-over-value pairs. */
  limits: { marginTop: space.s4 },
  limitGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s4,
  },
  limitWide: { gridColumn: "span 2" },
  limitLabel: { margin: 0, fontSize: text.sm, lineHeight: leading.sm, color: ink.muted },
  limitValue: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: ink.strong,
  },
  limitValueQuiet: { color: ink.muted },

  storage: { marginTop: space.s1 },
  storageHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between" },
  storagePercent: { fontSize: text.xs, lineHeight: leading.xs, color: ink.muted },
  /**
   * The usage meter. Its fill changes colour as the quota fills, so the bar
   * reports pressure without anyone having to read the number beside it.
   */
  meter: {
    marginTop: space.s1_5,
    height: 8,
    width: "100%",
    overflow: "hidden",
    borderRadius: radii.pill,
    backgroundColor: neutral.n200,
  },
  meterFill: { height: "100%", borderRadius: radii.pill },
  meterWidth: (percent: number) => ({ width: `${percent}%` }),
  meterOk: { backgroundColor: accent.a500 },
  meterWarn: { backgroundColor: warning.w500 },
  meterFull: { backgroundColor: danger.d500 },
  retry: { marginTop: space.s2 },

  actions: { marginTop: space.s4 },
  manage: { marginTop: space.s4, gap: space.s2, alignSelf: "flex-start" },
});
import { useQuery } from "@tanstack/react-query";
import { Button } from "@orbmeet/ui/react";
import { Badge } from "@orbmeet/ui/react";
import { SettingsSection } from "./settings-section";
import { QueryErrorNotice } from "@/app/query-client/query-error-notice";
import { formatPlanDuration, getPlanLimits, type SubscriptionTier } from "@/modules/billing/contract/plan-limits";
import type { SubscriptionStatus } from "@/modules/billing/contract/types";
import {
  openBillingPortal,
  startSubscriptionCheckout,
} from "@/modules/billing/client/billing-client";
import { storageUsageQueryOptions } from "@/app/query-client/queries/settings";

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Unlimited";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

interface PlanSectionProps {
  plan?: SubscriptionTier;
  subscriptionStatus?: SubscriptionStatus;
  hasManagedSubscription?: boolean;
}

export function PlanSection({
  plan = "free",
  subscriptionStatus,
  hasManagedSubscription = false,
}: PlanSectionProps) {
  const limits = getPlanLimits(plan);
  const storageQuery = useQuery(storageUsageQueryOptions());
  const [loading, setLoading] = React.useState<"pro" | "organization" | "portal" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  async function startCheckout(targetPlan: "pro" | "organization") {
    setLoading(targetPlan);
    setError(null);
    try {
      await startSubscriptionCheckout(targetPlan);
    } catch (err) {
      console.error("Checkout failed:", err);
      setError("Something went wrong. Please try again or contact support.");
    } finally {
      setLoading(null);
    }
  }

  async function openPortal() {
    setLoading("portal");
    setError(null);
    try {
      await openBillingPortal();
    } catch (err) {
      console.error("Billing portal failed:", err);
      setError("Could not open the billing portal. Please try again or contact support.");
    } finally {
      setLoading(null);
    }
  }

  return (
    <SettingsSection title="Plan & Billing">
      <div {...stylex.props(row.x3)}>
        <Badge variant="primary" size="md">
          {plan === "free" ? "Free Plan" : plan === "pro" ? "Pro Plan" : "Organization Plan"}
        </Badge>
        {subscriptionStatus && subscriptionStatus !== "active" && (
          <Badge variant="warning" size="md" sx={styles.statusBadge}>
            {subscriptionStatus.replace("_", " ")}
          </Badge>
        )}
      </div>
      <p {...stylex.props(settings.blurb, styles.summary)}>
        {plan === "free"
          ? "You are on Free: one permanent personal meeting link and one Space."
          : plan === "pro"
            ? "You are on Pro: cloud recording, a custom Meeting code, and higher limits."
            : "You are on Organization: shared billing, licensed users, and Organization-funded Spaces."}
      </p>
      <div {...stylex.props(settings.formPanel, styles.limits)}>
        <div {...stylex.props(styles.limitGrid)}>
          <div>
            <p {...stylex.props(styles.limitLabel)}>Concurrent meetings</p>
            <p {...stylex.props(styles.limitValue)}>{limits.maxConcurrentMeetings ?? "Unlimited"}</p>
          </div>
          <div>
            <p {...stylex.props(styles.limitLabel)}>Max participants</p>
            <p {...stylex.props(styles.limitValue)}>{limits.maxParticipants ?? "Unlimited"}</p>
          </div>
          <div>
            <p {...stylex.props(styles.limitLabel)}>Meeting duration</p>
            <p {...stylex.props(styles.limitValue)}>{formatPlanDuration(limits.maxMeetingDurationMinutes)}</p>
          </div>
          <div>
            <p {...stylex.props(styles.limitLabel)}>Spaces</p>
            <p {...stylex.props(styles.limitValue)}>{limits.maxSpaces ?? "Unlimited"}</p>
          </div>
          <div>
            <p {...stylex.props(styles.limitLabel)}>Members per Space</p>
            <p {...stylex.props(styles.limitValue)}>{limits.maxMembersPerSpace ?? "Unlimited"}</p>
          </div>
          <div>
            <p {...stylex.props(styles.limitLabel)}>Active Whiteboards per Space</p>
            <p {...stylex.props(styles.limitValue)}>{limits.maxWhiteboardsPerSpace}</p>
          </div>
          <div>
            <p {...stylex.props(styles.limitLabel)}>Personal links</p>
            <p {...stylex.props(styles.limitValue)}>Included</p>
          </div>
          <div {...stylex.props(styles.limitWide)}>
            <p {...stylex.props(styles.limitLabel)}>Storage</p>
            {storageQuery.isPending ? (
              <p {...stylex.props(styles.limitValue, styles.limitValueQuiet)}>Loading storage usage…</p>
            ) : storageQuery.isError ? (
              <QueryErrorNotice
                message="Storage usage could not be loaded."
                onRetry={() => { void storageQuery.refetch(); }}
sx={styles.retry}
              />
            ) : storageQuery.data ? (
              <div {...stylex.props(styles.storage)}>
                <div {...stylex.props(styles.storageHead)}>
                  <p {...stylex.props(styles.limitValue)}>
                    {formatBytes(storageQuery.data.usedBytes)} / {storageQuery.data.maxBytes !== null ? formatBytes(storageQuery.data.maxBytes) : "Unlimited"}
                  </p>
                  {storageQuery.data.maxBytes !== null && (
                    <span {...stylex.props(styles.storagePercent)}>
                      {Math.round((storageQuery.data.usedBytes / storageQuery.data.maxBytes) * 100)}%
                    </span>
                  )}
                </div>
                {storageQuery.data.maxBytes !== null && (
                  <div {...stylex.props(styles.meter)}>
                    {(() => {
                      const ratio = storageQuery.data.usedBytes / storageQuery.data.maxBytes;
                      return (
                        <div
                          {...stylex.props(
                            styles.meterFill,
                            motion.move,
                            styles.meterWidth(Math.min(100, ratio * 100)),
                            ratio > 0.9
                              ? styles.meterFull
                              : ratio > 0.7
                                ? styles.meterWarn
                                : styles.meterOk,
                          )}
                        />
                      );
                    })()}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {hasManagedSubscription ? (
        <Button
          variant="secondary"
          sx={styles.manage}
          onClick={() => {
            void openPortal();
          }}
          disabled={loading === "portal"}
        >
          <ExternalLink size={14} />
          {loading === "portal" ? "Opening..." : "Manage billing"}
        </Button>
      ) : (
        <div {...stylex.props(row.x3, styles.actions)}>
          {plan !== "pro" && plan !== "organization" && (
            <Button
              variant="secondary"
              onClick={() => {
                void startCheckout("pro");
              }}
              disabled={loading !== null}
            >
              {loading === "pro" ? "Loading..." : "Upgrade to Pro — $5/mo"}
            </Button>
          )}
          {plan !== "organization" && (
            <Button
              variant="secondary"
              onClick={() => {
                void startCheckout("organization");
              }}
              disabled={loading !== null}
            >
              {loading === "organization" ? "Loading..." : "Upgrade to Organization — $10/user/mo"}
            </Button>
          )}
        </div>
      )}
      {error && <p {...stylex.props(settings.error)}>{error}</p>}
    </SettingsSection>
  );
}

import { useMutation, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { sessionsListQueryOptions } from "@/app/query-client/queries/settings";
import { revokeSession, revokeAllOtherSessions } from "@/modules/identity/server/account.functions";
import { queryKeys } from "@/app/query-client/query-keys";
import { resetAuthQueryCache } from "@/modules/identity/client/auth-query-cache";
import { Button } from "@orbmeet/ui/react";
import { Badge } from "@orbmeet/ui/react";
import { Alert } from "@orbmeet/ui/react";
import { layout, row, stack } from "@orbmeet/ui/styles/atoms";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import * as stylex from "@stylexjs/stylex";

import { settings } from "../settings-styles";

const styles = stylex.create({
  revokeAll: { marginTop: space.s2, alignSelf: "flex-start" },
});
import { describeUserAgent } from "@/lib/browser-capabilities";
import { SettingsSection } from "./settings-section";
import {
  StepUpDialog,
  type StepUpCredentialInput,
} from "./step-up-dialog";
import { useState } from "react";

export function SessionsSection() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<
    { type: "single"; sessionId: string } | { type: "others" } | null
  >(null);

  const { data: sessionsList } = useSuspenseQuery(sessionsListQueryOptions());

  const revokeMutation = useMutation({
    mutationFn: (input: {
      sessionId: string;
      credential: StepUpCredentialInput;
    }) => revokeSession({ data: input }),
    onSuccess: async (result) => {
      setPendingAction(null);
      if (result.wasCurrentSession) {
        // Signed out here: nothing cached belongs to whoever signs in next.
        await resetAuthQueryCache(queryClient);
        await router.invalidate();
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all() });
    },
  });

  const revokeAllMutation = useMutation({
    mutationFn: (credential: StepUpCredentialInput) =>
      revokeAllOtherSessions({ data: { credential } }),
    onSuccess: async () => {
      setPendingAction(null);
      // Signing out everywhere else revokes every API key too.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.personalAccessTokens() }),
      ]);
    },
  });

  const otherSessions = sessionsList.filter((s) => !s.isCurrent);

  return (
    <SettingsSection title="Signed-in devices">
      <div {...stylex.props(stack.x4)}>
        {sessionsList.map((session) => (
          <div key={session.id} {...stylex.props(settings.itemRow)}>
            <div {...stylex.props(layout.minZero)}>
              <div {...stylex.props(row.x2)}>
                <p {...stylex.props(settings.itemName, layout.truncate)}>
                  {describeUserAgent(session.userAgent)}
                </p>
                {session.isCurrent && (
                  <Badge variant="success" size="sm">Current</Badge>
                )}
              </div>
              <p {...stylex.props(settings.itemMeta, settings.itemMetaSpaced)}>
                {session.ipAddress || "Unknown IP"} · Signed in{" "}
                {formatRelativeTime(session.createdAt)}
              </p>
            </div>
            {!session.isCurrent && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPendingAction({ type: "single", sessionId: session.id })}
                loading={
                  revokeMutation.isPending
                  && revokeMutation.variables?.sessionId === session.id
                }
              >
                Revoke
              </Button>
            )}
          </div>
        ))}

        {otherSessions.length > 0 && (
          <Button
            variant="secondary"
            onClick={() => setPendingAction({ type: "others" })}
            loading={revokeAllMutation.isPending}
            sx={styles.revokeAll}
          >
            Revoke all other sessions
          </Button>
        )}

        {revokeMutation.isError && (
          <Alert variant="error">
            {revokeMutation.error instanceof Error ? revokeMutation.error.message : "Failed to sign out this device."}
          </Alert>
        )}
      </div>
      <StepUpDialog
        open={pendingAction !== null}
        action={pendingAction?.type === "single" ? "session_revoke" : "sessions_revoke_others"}
        targetId={pendingAction?.type === "single" ? pendingAction.sessionId : undefined}
        title={
          pendingAction?.type === "single"
            ? "Sign out this device?"
            : "Sign out all other devices?"
        }
        description={
          pendingAction?.type === "single"
            ? "Verify your identity before signing this device out of your account."
            : "Verify your identity. This signs out every other device and revokes all of your API keys."
        }
        confirming={revokeMutation.isPending || revokeAllMutation.isPending}
        actionError={
          revokeMutation.isError
            ? (revokeMutation.error instanceof Error
              ? revokeMutation.error.message
              : "Failed to sign out this device.")
            : revokeAllMutation.isError
              ? (revokeAllMutation.error instanceof Error
                ? revokeAllMutation.error.message
                : "Failed to sign out other devices.")
              : undefined
        }
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
        onConfirm={(credential) => {
          if (pendingAction?.type === "single") {
            revokeMutation.mutate({
              sessionId: pendingAction.sessionId,
              credential,
            });
          } else if (pendingAction?.type === "others") {
            revokeAllMutation.mutate(credential);
          }
        }}
      />
    </SettingsSection>
  );
}

function formatRelativeTime(date: Date | null): string {
  if (!date) return "Unknown";
  const diff = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

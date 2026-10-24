import { useState } from "react";
import { useMutation, useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { stack } from "@orbmeet/ui/styles/atoms";
import { danger } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { KeyRound, Trash2 } from "lucide-react";

import { settings } from "../settings-styles";

const styles = stylex.create({
  addButton: { alignSelf: "flex-start", gap: space.s2 },
  error: { margin: 0, fontSize: text.sm, lineHeight: leading.sm, color: danger.d600 },
  /** Passkey rows are tighter than the device rows — more of them, less to say. */
  passkeyRow: { paddingInline: space.s3, paddingBlock: space.s2 },
  passkeyName: { fontSize: text.sm, fontWeight: weight.medium },
  passkeyMeta: { fontSize: text.xs, lineHeight: leading.xs },
  remove: { color: { default: danger.d600, [env.hoverable]: { default: danger.d600, ":hover:not(:disabled)": danger.d700 } } },
});
import { deletePasskey, finishPasskeyRegistration, startPasskeyRegistration } from "@/modules/identity/server/passkey.functions";
import { getErrorMessage } from "@/lib/error-inspection";
import { passkeysQueryOptions } from "@/app/query-client/queries/settings";
import { usePasskeySupport } from "@/lib/hooks/use-passkey-support";
import { SettingsSection } from "./settings-section";
import { Button } from "@orbmeet/ui/react";
import {
  StepUpDialog,
  type StepUpCredentialInput,
} from "./step-up-dialog";

export function SecuritySection() {
  const passkeySupported = usePasskeySupport();
  const [error, setError] = useState("");
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState<
    { type: "add" } | { type: "delete"; passkeyId: string } | null
  >(null);

  const { data: passkeys } = useSuspenseQuery(passkeysQueryOptions());

  const addPasskeyMutation = useMutation({
    mutationFn: async (credential: StepUpCredentialInput) => {
      const { options, registrationToken } = await startPasskeyRegistration({
        data: { credential },
      });
      const { startRegistration } = await import("@simplewebauthn/browser");
      const response = await startRegistration({ optionsJSON: options });
      await finishPasskeyRegistration({
        data: { response, registrationToken },
      });
    },
    onSuccess: async () => {
      setError("");
      setPendingAction(null);
      await queryClient.invalidateQueries({ queryKey: passkeysQueryOptions().queryKey });
    },
    onError: (err) => {
      setError(getErrorMessage(err, "Could not register passkey."));
    },
  });

  const deletePasskeyMutation = useMutation({
    mutationFn: (input: {
      passkeyId: string;
      credential: StepUpCredentialInput;
    }) => deletePasskey({ data: input }),
    onSuccess: async () => {
      setError("");
      setPendingAction(null);
      await queryClient.invalidateQueries({ queryKey: passkeysQueryOptions().queryKey });
    },
    onError: (err) => {
      setError(getErrorMessage(err, "Could not remove passkey."));
    },
  });

  return (
    <SettingsSection title="Security">
      <div {...stylex.props(stack.x4)}>
        <p {...stylex.props(settings.blurb)}>
          OTP email sign-in stays available for older devices. Add passkeys for faster sign-in where supported.
        </p>

        {passkeySupported ? (
          <Button
            type="button"
            variant="secondary"
            sx={styles.addButton}
            loading={addPasskeyMutation.isPending}
            onClick={() => {
              setError("");
              setPendingAction({ type: "add" });
            }}
          >
            <KeyRound size={16} />
            Add Passkey
          </Button>
        ) : (
          <p {...stylex.props(settings.blurb)}>This browser does not support passkeys.</p>
        )}

        {error && <p {...stylex.props(styles.error)}>{error}</p>}

        <div {...stylex.props(stack.x2)}>
          {passkeys.length === 0 && (
            <p {...stylex.props(settings.blurb)}>No passkeys added yet.</p>
          )}
          {passkeys.map((pk) => (
            <div key={pk.id} {...stylex.props(settings.itemRow, styles.passkeyRow)}>
              <div>
                <p {...stylex.props(settings.itemName, styles.passkeyName)}>
                  {pk.name || "Unnamed passkey"}
                </p>
                <p {...stylex.props(settings.itemMeta, styles.passkeyMeta)}>
                  {pk.deviceType === "multiDevice" ? "Synced device" : "Single device"}
                  {pk.lastUsedAt ? ` • Last used ${new Date(pk.lastUsedAt).toLocaleDateString()}` : ""}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                sx={styles.remove}
                onClick={() => setPendingAction({ type: "delete", passkeyId: pk.id })}
                disabled={deletePasskeyMutation.isPending}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
        </div>
      </div>
      <StepUpDialog
        open={pendingAction !== null}
        action={pendingAction?.type === "delete" ? "passkey_delete" : "passkey_register"}
        targetId={pendingAction?.type === "delete" ? pendingAction.passkeyId : undefined}
        title={pendingAction?.type === "delete" ? "Remove passkey?" : "Add a passkey"}
        description={
          pendingAction?.type === "delete"
            ? "Verify your identity before removing this sign-in method."
            : "Verify your identity before creating a new sign-in method."
        }
        confirming={addPasskeyMutation.isPending || deletePasskeyMutation.isPending}
        actionError={error}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
        onConfirm={(credential) => {
          if (pendingAction?.type === "delete") {
            deletePasskeyMutation.mutate({
              passkeyId: pendingAction.passkeyId,
              credential,
            });
          } else if (pendingAction?.type === "add") {
            addPasskeyMutation.mutate(credential);
          }
        }}
      />
    </SettingsSection>
  );
}

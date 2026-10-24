import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { requestStepUp } from "@/modules/identity/server/step-up.functions";
import { deleteAccount } from "@/workflows/account-deletion/delete-account.functions";
import { Button } from "@orbmeet/ui/react";
import { Input } from "@orbmeet/ui/react";
import { Alert } from "@orbmeet/ui/react";
import { row, stack, type as typeStyles } from "@orbmeet/ui/styles/atoms";
import { danger, ink, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { AlertTriangle } from "lucide-react";

const styles = stylex.create({
  /** The settings panel around this section already carries the red edge. */
  zone: { display: "flex", flexDirection: "column" },
  head: { marginBottom: space.s4 },
  icon: { color: danger.d500 },
  title: { margin: 0, color: danger.d800 },
  blurb: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.body,
  },
  /**
   * A secondary button wearing the danger palette: the destructive path is
   * never the loud one until it has been confirmed.
   */
  armed: {
    borderColor: danger.d200,
    color: { default: danger.d600, [env.hoverable]: { default: danger.d600, ":hover:not(:disabled)": danger.d700 } },
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover:not(:disabled)": danger.d50 } },
  },
  armedSpaced: { marginTop: space.s4, alignSelf: "flex-start" },
  confirm: {
    backgroundColor: { default: danger.d600, [env.hoverable]: { default: danger.d600, ":hover:not(:disabled)": danger.d700 } },
    color: ink.onDark,
  },
  otp: {
    marginTop: space.s1,
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    letterSpacing: tracking.widest,
  },
  spacedField: { marginTop: space.s1 },
  keyword: { fontFamily: fonts.mono, fontWeight: weight.bold },
});
import { EMAIL_CODE_LENGTH } from "@/modules/identity/contract/auth/constants";

export function DangerZoneSection() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [flowToken, setFlowToken] = useState("");

  const requestOtpMutation = useMutation({
    mutationFn: () => requestStepUp({ data: { action: "account_delete" } }),
    onSuccess: (result) => {
      setFlowToken(result.flowToken);
      setOtpSent(true);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      deleteAccount({
        data: {
          confirmation: "DELETE",
          credential: { flowToken, otp },
        },
      }),
    onSuccess: async () => {
      await queryClient.cancelQueries();
      queryClient.clear();
      void navigate({ to: "/" });
    },
  });

  const canDelete = confirmation === "DELETE"
    && otp.length === EMAIL_CODE_LENGTH
    && Boolean(flowToken);

  function handleCancel() {
    setShowConfirm(false);
    setConfirmation("");
    setOtp("");
    setOtpSent(false);
    setFlowToken("");
  }

  return (
    <section {...stylex.props(styles.zone)}>
      <div {...stylex.props(row.x2, styles.head)}>
        <AlertTriangle size={18} {...stylex.props(styles.icon)} />
        <h2 {...stylex.props(typeStyles.sectionTitle, styles.title)}>Danger Zone</h2>
      </div>

      {!showConfirm ? (
        <>
          <p {...stylex.props(styles.blurb)}>
            Deleting your account removes your profile and personal workspace. Content owned by shared Spaces remains with those Spaces.
          </p>
          <Button
            variant="secondary"
            sx={[styles.armed, styles.armedSpaced]}
            onClick={() => setShowConfirm(true)}
          >
            Delete account
          </Button>
        </>
      ) : (
        <div {...stylex.props(stack.x4)}>
          <Alert variant="error">
            This action is permanent. Your account, personal Meetings, personal Whiteboards, and personal files will be deleted. Shared-Space content remains with its Space. You must transfer or delete any Space or Organization you own first.
          </Alert>

          {!otpSent ? (
            <>
              <p {...stylex.props(styles.blurb)}>
                We'll send a confirmation code to your email address.
              </p>
              <Button
                variant="secondary"
                sx={styles.armed}
                onClick={() => requestOtpMutation.mutate()}
                loading={requestOtpMutation.isPending}
              >
                Send confirmation code
              </Button>
            </>
          ) : (
            <>
              <div>
                <Input
                  label="Enter the confirmation code sent to your email"
                  value={otp}
                  onChange={(e) =>
                    setOtp(
                      e.target.value
                        .replace(/\D/g, "")
                        .slice(0, EMAIL_CODE_LENGTH),
                    )
                  }
                  placeholder="123456"
                  sx={styles.otp}
                  maxLength={EMAIL_CODE_LENGTH}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoFocus
                  autoComplete="one-time-code"
                />
              </div>

              <div>
                <Input
                  label={
                    <>
                      Type <span {...stylex.props(styles.keyword)}>DELETE</span> to confirm
                    </>
                  }
                  sx={styles.spacedField}
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  placeholder="DELETE"
                  autoComplete="off"
                />
              </div>
            </>
          )}

          <div {...stylex.props(row.x3)}>
            <Button variant="secondary" onClick={handleCancel}>
              Cancel
            </Button>
            {otpSent && (
              <Button
                sx={styles.confirm}
                onClick={() => deleteMutation.mutate()}
                loading={deleteMutation.isPending}
                disabled={!canDelete}
              >
                Permanently delete account
              </Button>
            )}
          </div>

          {(requestOtpMutation.isError || deleteMutation.isError) && (
            <Alert variant="error">
              {requestOtpMutation.isError
                ? (requestOtpMutation.error instanceof Error ? requestOtpMutation.error.message : "Failed to send code.")
                : (deleteMutation.error instanceof Error ? deleteMutation.error.message : "Failed to delete account.")}
            </Alert>
          )}
        </div>
      )}
    </section>
  );
}

import { getRouteApi } from "@tanstack/react-router";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { OTPField } from "@base-ui/react/otp-field";
import { Field } from "@base-ui/react/field";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { verifyOtp, resendOtp } from "@/modules/identity/server/signup.functions";
import { verifyLoginOtp, resendLoginOtp } from "@/modules/identity/server/login.functions";
import { resetAuthQueryCache } from "@/modules/identity/client/auth-query-cache";
import { resolveAuthRedirect } from "@/modules/identity/contract/safe-redirect";
import { getErrorMessage } from "@/lib/error-inspection";
import { Spinner } from "@orbmeet/ui/react";
import { AuthLayout } from "@/modules/identity/client/components/auth-layout";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration } from "@orbmeet/ui/tokens/motion.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Button } from "@orbmeet/ui/react";
import {
  clearClientAuthFlow,
  loadClientAuthFlow,
} from "@/modules/identity/client/auth-flow";
import { EMAIL_CODE_LENGTH } from "@/modules/identity/contract/auth/constants";

const routeApi = getRouteApi("/verify");

const styles = stylex.create({
  title: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: "2rem",
    lineHeight: 1.05,
    fontWeight: weight.semibold,
    letterSpacing: "-0.045em",
    color: ink.strong,
  },
  lede: {
    marginTop: space.s2,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  error: {
    margin: 0,
    marginTop: space.s4,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: danger.d600,
  },
  backButton: { marginTop: space.s6, width: "100%" },

  description: {
    marginTop: space.s2,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  descriptionEmail: { fontWeight: weight.medium, color: neutral.n700 },
  loginHint: {
    marginTop: space.s2,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },

  // Left-aligned under the heading, like every other field in the flow.
  otpRow: {
    marginTop: space.s8,
    display: "flex",
    justifyContent: "flex-start",
    gap: space.s2,
  },
  /**
   * A digit cell. Focus is a border colour plus the app's ring-shaped shadow —
   * the same treatment the select trigger uses, so every field in the flow
   * focuses identically.
   */
  otpInput: {
    height: 56,
    width: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n300, ":focus-visible": accent.a500 },
    backgroundColor: surface.raised,
    textAlign: "center",
    fontFamily: fonts.mono,
    fontSize: text.lg,
    fontWeight: weight.semibold,
    color: ink.strong,
    outlineStyle: "none",
    boxShadow: {
      default: "none",
      ":focus-visible": `0 0 0 2px color-mix(in oklab, ${accent.a500} 20%, transparent)`,
    },
    opacity: { default: 1, ":disabled": 0.5 },
    transitionProperty: "border-color, box-shadow",
    transitionDuration: { default: duration.instant, [env.reducedMotion]: "0s" },
  },

  pendingRow: {
    marginTop: space.s4,
    display: "flex",
    justifyContent: "flex-start",
  },
  statusMessage: {
    margin: 0,
    marginTop: space.s4,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: neutral.n600,
  },
  resendBlock: { marginTop: space.s8 },
  resendLede: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  resendButton: {
    fontFamily: "inherit",
    padding: 0,
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: { default: accent.a700, [env.hoverable]: { default: accent.a700, ":hover": accent.a800 } },
    opacity: { default: 1, ":disabled": 0.5 },
  },
});

export function VerifyPage() {
  const { flowId, redirect: redirectTo } = routeApi.useSearch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [flow] = useState(() => loadClientAuthFlow(flowId));
  const isLogin = flow?.mode === "login";

  const [otpValue, setOtpValue] = useState("");
  const [error, setError] = useState("");
  const [resendMsg, setResendMsg] = useState("");

  const verifyMutation = useMutation({
    mutationFn: async (otpCode: string) => {
      const result = isLogin
        ? await verifyLoginOtp({ data: { flowToken: flow?.flowToken ?? "", otp: otpCode } })
        : await verifyOtp({ data: { flowToken: flow?.flowToken ?? "", otp: otpCode } });
      return {
        ...result,
        deletionPending: "deletionPending" in result ? result.deletionPending : false,
      };
    },
    onSuccess: async (result) => {
      clearClientAuthFlow(flowId);
      // A deletion-gated account just received the deletion-resume session,
      // not a login; send it to the recovery surface instead of the app.
      if (result.deletionPending) {
        await resetAuthQueryCache(queryClient);
        router.history.push("/account/deletion-pending");
        return;
      }
      await resetAuthQueryCache(queryClient);
      router.history.push(resolveAuthRedirect(redirectTo));
    },
    onError: (err) => {
      setError(getErrorMessage(err, "Invalid or expired code."));
      setOtpValue("");
    },
  });

  const resendMutation = useMutation({
    mutationFn: () =>
      isLogin
        ? resendLoginOtp({ data: { flowToken: flow?.flowToken ?? "" } })
        : resendOtp({ data: { flowToken: flow?.flowToken ?? "" } }),
    onSuccess: (result) => {
      const resent = typeof result === "object" && result !== null && "resent" in result
        ? result.resent
        : true;
      setResendMsg(resent ? "A new code has been sent." : "Please wait before requesting another code.");
      setError("");
    },
    onError: (err) => {
      setResendMsg(getErrorMessage(err, "Failed to resend code. Please try again."));
    },
  });

  if (!flow) {
    return (
      <AuthLayout>
        <div {...stylex.props(enter.fadeUp)}>
          <h1 {...stylex.props(styles.title)}>Verification expired</h1>
          <p {...stylex.props(styles.lede)}>
            Start sign-in again in this tab to request a new code.
          </p>
          <Button
            type="button"
            sx={styles.backButton}
            onClick={() => void router.navigate({ to: "/auth", search: { redirect: redirectTo } })}
          >
            Back to sign in
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div {...stylex.props(enter.fadeUp)}>
        <h1 {...stylex.props(styles.title)}>
          {isLogin ? "Check your email" : "Verify your email"}
        </h1>
        <Field.Root invalid={Boolean(error)}>
          <Field.Label {...stylex.props(layout.srOnly)}>Verification code</Field.Label>
          <Field.Description {...stylex.props(styles.description)}>
            Enter the {EMAIL_CODE_LENGTH}-digit code sent to{" "}
            <span {...stylex.props(styles.descriptionEmail)}>{flow.email}</span>
          </Field.Description>
          <p {...stylex.props(styles.loginHint)}>
            This code expires in 10 minutes. {isLogin ? "Enter it to sign in." : "Enter it to finish creating your account."}
          </p>

          <OTPField.Root
            length={EMAIL_CODE_LENGTH}
            validationType="numeric"
            inputMode="numeric"
            value={otpValue}
            onValueChange={(val) => {
              setOtpValue(val);
              setError("");
              setResendMsg("");
            }}
            onValueComplete={(val) => {
              if (!verifyMutation.isPending && !resendMutation.isPending) verifyMutation.mutate(val);
            }}
            disabled={verifyMutation.isPending || resendMutation.isPending}
            {...stylex.props(styles.otpRow)}
          >
            {Array.from({ length: EMAIL_CODE_LENGTH }, (_, i) => (
              <OTPField.Input
                key={i}
                autoFocus={i === 0}
                aria-label={
                  i === 0 ? undefined : `Digit ${i + 1} of ${EMAIL_CODE_LENGTH}`
                }
                {...stylex.props(styles.otpInput)}
              />
            ))}
          </OTPField.Root>

          {error && (
            <Field.Error
              match
              role="alert"
              {...stylex.props(styles.error)}
            >
              {error}
            </Field.Error>
          )}
        </Field.Root>

        {verifyMutation.isPending && (
          <div {...stylex.props(styles.pendingRow)}>
            <Spinner brand />
          </div>
        )}

        {resendMsg && (
          <p role="status" {...stylex.props(styles.statusMessage)}>
            {resendMsg}
          </p>
        )}

        <div {...stylex.props(styles.resendBlock)}>
          <p {...stylex.props(styles.resendLede)}>
            Didn&apos;t receive a code?{" "}
            <button
              type="button"
              onClick={() => {
                setOtpValue("");
                setError("");
                setResendMsg("");
                resendMutation.mutate();
              }}
              disabled={resendMutation.isPending || verifyMutation.isPending}
              {...stylex.props(pressable.base, motion.tint, focus.ring, styles.resendButton)}
            >
              {resendMutation.isPending ? "Sending..." : "Resend"}
            </button>
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          sx={styles.backButton}
          disabled={verifyMutation.isPending || resendMutation.isPending}
          onClick={() => {
            clearClientAuthFlow(flowId);
            void router.navigate({ to: "/auth", search: { redirect: redirectTo } });
          }}
        >
          Use another email
        </Button>
      </div>
    </AuthLayout>
  );
}

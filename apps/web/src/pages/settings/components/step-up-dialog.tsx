import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { EMAIL_CODE_LENGTH } from "@/modules/identity/contract/auth/constants";
import type { StepUpAction } from "@/modules/identity/contract/auth/schemas";
import { requestStepUp } from "@/modules/identity/server/step-up.functions";
import { getErrorMessage } from "@/lib/error-inspection";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@orbmeet/ui/react";
import { Alert } from "@orbmeet/ui/react";
import { Button } from "@orbmeet/ui/react";
import { Input } from "@orbmeet/ui/react";
import { stack, type as typeStyles } from "@orbmeet/ui/styles/atoms";
import { fonts, tracking } from "@orbmeet/ui/tokens/typography.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { ink } from "@orbmeet/ui/tokens/colors.stylex";
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  /**
   * A one-time code, set the way a code should be: monospaced, upper case and
   * spaced out, so a digit read off a phone lands where the eye expects it.
   */
  otp: {
    marginTop: space.s1,
    fontFamily: fonts.mono,
    textTransform: "uppercase",
    letterSpacing: tracking.widest,
  },
  hint: { marginTop: space.s2, marginBottom: 0, fontSize: "0.75rem", color: ink.muted },
});

export interface StepUpCredentialInput {
  flowToken: string;
  otp: string;
}

interface StepUpDialogProps {
  open: boolean;
  action: StepUpAction;
  targetId?: string;
  title: string;
  description: string;
  confirming?: boolean;
  actionError?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (credential: StepUpCredentialInput) => void;
}

export function StepUpDialog({
  open,
  action,
  targetId,
  title,
  description,
  confirming = false,
  actionError,
  onOpenChange,
  onConfirm,
}: StepUpDialogProps) {
  const [flowToken, setFlowToken] = useState("");
  const [otp, setOtp] = useState("");
  const requestedKeyRef = useRef<string | null>(null);
  const requestMutation = useMutation({
    mutationFn: () => requestStepUp({ data: { action, targetId } }),
    onSuccess: (result) => setFlowToken(result.flowToken),
  });
  const requestCode = requestMutation.mutate;
  const resetRequest = requestMutation.reset;

  useEffect(() => {
    if (!open) {
      requestedKeyRef.current = null;
      setFlowToken("");
      setOtp("");
      resetRequest();
      return;
    }
    const requestKey = `${action}:${targetId ?? ""}`;
    if (requestedKeyRef.current === requestKey) return;
    requestedKeyRef.current = requestKey;
    setFlowToken("");
    setOtp("");
    resetRequest();
    requestCode();
  }, [action, open, requestCode, resetRequest, targetId]);

  const requestError = requestMutation.isError
    ? getErrorMessage(requestMutation.error, "Could not send a security code.")
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <DialogBody sx={stack.x4}>
          {requestMutation.isPending ? (
            <p {...stylex.props(typeStyles.muted)}>Sending a security code…</p>
          ) : flowToken ? (
            <div>
              <Input
                label="Security code"
                sx={styles.otp}
                value={otp}
                onChange={(event) => {
                  setOtp(
                    event.target.value
                      .replace(/\D/g, "")
                      .slice(0, EMAIL_CODE_LENGTH),
                  );
                }}
                placeholder="123456"
                maxLength={EMAIL_CODE_LENGTH}
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                autoFocus
              />
              <p {...stylex.props(styles.hint)}>
                We sent this one-time code to your account email.
              </p>
            </div>
          ) : null}

          {(requestError || actionError) && (
            <Alert variant="error">{requestError || actionError}</Alert>
          )}
        </DialogBody>

        <DialogFooter>
          <DialogClose render={<Button variant="secondary" disabled={confirming} />}>
            Cancel
          </DialogClose>
          {requestMutation.isError ? (
            <Button
              type="button"
              onClick={() => requestMutation.mutate()}
              loading={requestMutation.isPending}
            >
              Try again
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => onConfirm({ flowToken, otp })}
              loading={confirming}
              disabled={!flowToken || otp.length !== EMAIL_CODE_LENGTH}
            >
              Confirm
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useNavigate } from "@tanstack/react-router";
import { queryKeys } from "@/app/query-client/query-keys";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getDeletionPendingAccount } from "@/modules/identity/server/account.functions";
import { deleteAccount } from "@/workflows/account-deletion/delete-account.functions";
import { getErrorMessage } from "@/lib/error-inspection";
import { resetAuthQueryCache } from "@/modules/identity/client/auth-query-cache";
import { AuthLayout } from "@/modules/identity/client/components/auth-layout";
import { Alert } from "@orbmeet/ui/react";
import { Button } from "@orbmeet/ui/react";
import { Spinner } from "@orbmeet/ui/react";
import { enter } from "@orbmeet/ui/styles/animations";
import { stack } from "@orbmeet/ui/styles/atoms";
import { danger, ink } from "@orbmeet/ui/tokens/colors.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Trash2 } from "lucide-react";

const styles = stylex.create({
  title: {
    margin: 0,
    fontSize: text.xl2,
    fontWeight: weight.bold,
    color: ink.strong,
  },
  lede: {
    margin: 0,
    marginTop: space.s2,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.body,
  },
  finality: {
    margin: 0,
    marginTop: space.s3,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    fontWeight: weight.semibold,
    color: danger.d700,
  },
  email: { fontWeight: weight.medium },
  /** The icon is styled through a class: stylex vars can't sit on a raw style object. */
  icon: { color: danger.d500 },
  confirmButton: {
    marginTop: space.s5,
    width: "100%",
    // Deliberately no hover affordance: the destructive path is never the
    // inviting one.
    backgroundColor: danger.d600,
    borderColor: danger.d600,
    color: ink.onDark,
  },
  backButton: { marginTop: space.s3, width: "100%" },
  footnote: {
    margin: 0,
    marginTop: space.s3,
    fontSize: text.xs,
    lineHeight: leading.relaxed,
    color: ink.muted,
    textAlign: "center",
  },
});

export function DeletionPendingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // The session behind this page is a deletion-resume credential: it resolves
  // nothing else in the app, so the page reads its state straight from the
  // server on every load instead of relying on any flow token kept in
  // component state. A reload, a reopened tab, or a sign-in from the auth
  // page all land here with a working action.
  const stateQuery = useQuery({
    queryKey: queryKeys.accountDeletionPending(),
    queryFn: () => getDeletionPendingAccount(),
    retry: false,
    staleTime: 0,
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      // No credential: a resumed attempt already crossed the step-up boundary,
      // and the retained session is the authorization.
      deleteAccount({ data: { confirmation: "DELETE" } }),
    onSuccess: async () => {
      await resetAuthQueryCache(queryClient);
      void navigate({ to: "/" });
    },
  });

  const state = stateQuery.data;
  const pending = state?.deletionPending === true;

  // Anything without an active gate (signed out, already deleted) belongs at
  // sign-in, which is also where a fresh recovery session is issued.
  useEffect(() => {
    if (stateQuery.isSuccess && !pending) {
      void navigate({ to: "/auth", search: { mode: "login" } });
    }
  }, [stateQuery.isSuccess, pending, navigate]);

  if (!stateQuery.isSuccess) {
    return (
      <AuthLayout>
        <div {...stylex.props(stack.x4, enter.fade)}>
          {stateQuery.isPending && <Spinner brand />}
          {stateQuery.isError && (
            <>
              <Alert variant="error">
                {getErrorMessage(
                  stateQuery.error,
                  "We couldn't check your account state. Please try again.",
                )}
              </Alert>
              {/* A missing or expired recovery session is the common cause;
                  sign-in re-issues one. */}
              <Button
                variant="secondary"
                onClick={() => void navigate({ to: "/auth", search: { mode: "login" } })}
              >
                Back to sign in
              </Button>
            </>
          )}
        </div>
      </AuthLayout>
    );
  }

  if (!pending) return null;

  return (
    <AuthLayout>
      <div {...stylex.props(enter.fade)}>
        <div {...stylex.props(stack.x2)}>
          <Trash2 size={28} {...stylex.props(styles.icon)} />
          <h1 {...stylex.props(styles.title)}>Account deletion pending</h1>
        </div>

        <p {...stylex.props(styles.lede)}>
          A deletion of the account for <span {...stylex.props(styles.email)}>{state.email}</span>{" "}
          has already started. This account is signed out everywhere and cannot be used while the
          deletion is in progress.
        </p>
        <p {...stylex.props(styles.finality)}>
          This cannot be undone. The account cannot be reopened, re-registered, or restored —
          finishing the deletion is permanent.
        </p>

        <Button
          sx={styles.confirmButton}
          onClick={() => deleteMutation.mutate()}
          loading={deleteMutation.isPending}
          disabled={deleteMutation.isPending}
        >
          Finish deleting my account now
        </Button>

        {deleteMutation.isError && (
          <Alert variant="error">
            {getErrorMessage(
              deleteMutation.error,
              "The deletion couldn't be finished. It is safe to try again.",
            )}
          </Alert>
        )}

        {/* Not a cancel — there is none, as the copy above says. This session
            can reach only this page and the deletion endpoint, so sending it
            to "/" bounced straight back to sign-in and read as a cancel that
            silently did nothing. Name the one thing the button actually does. */}
        <Button
          variant="secondary"
          sx={styles.backButton}
          disabled={deleteMutation.isPending}
          onClick={() => void navigate({ to: "/auth", search: { mode: "login" } })}
        >
          Finish later
        </Button>
        <p {...stylex.props(styles.footnote)}>
          Leaving this page does not stop the deletion. It continues on its own, and signing in
          again returns you here.
        </p>
      </div>
    </AuthLayout>
  );
}

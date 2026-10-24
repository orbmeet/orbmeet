import { getRouteApi } from "@tanstack/react-router";
import { useNavigate } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { joinViaInvite } from "@/modules/spaces/server/invites.functions";
import { invitePreviewQueryOptions } from "@/app/query-client/queries/spaces";
import { queryKeys } from "@/app/query-client/query-keys";
import { Button } from "@orbmeet/ui/react";
import { Spinner } from "@orbmeet/ui/react";
import { danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { AuthLayout } from "@/modules/identity/client/components/auth-layout";
import * as stylex from "@stylexjs/stylex";
import { RouteError } from "@/app/shell/route-state";
import { evictSpaceQueryCache } from "@/modules/spaces/client/space-query-cache";

const routeApi = getRouteApi("/join/$token");

const styles = stylex.create({
  ground: {
    display: "flex",
    height: "100vh",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: surface.canvas,
  },
  errorStack: {
    display: "flex",
    height: "100vh",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s4,
    backgroundColor: surface.canvas,
  },
  errorMessage: { margin: 0, color: danger.d600 },
  errorActions: { display: "flex", gap: space.s3 },

  pendingColumn: { textAlign: "center" },
  pendingSpinner: { marginInline: "auto", marginBottom: space.s4 },
  pendingText: { margin: 0, color: neutral.n600 },

  eyebrow: { margin: 0, marginBottom: space.s2, fontSize: text.sm, color: ink.muted },
  title: {
    margin: 0,
    fontFamily: fonts.heading,
    fontSize: "2rem",
    lineHeight: 1.05,
    fontWeight: weight.semibold,
    letterSpacing: "-0.045em",
    color: ink.strong,
    overflowWrap: "anywhere",
  },
  detail: {
    marginTop: space.s2,
    marginBottom: 0,
    fontSize: text.sm,
    lineHeight: leading.relaxed,
    color: ink.muted,
  },
  actions: { marginTop: space.s6, display: "flex", flexDirection: "column", gap: space.s2 },
  action: { width: "100%" },
});

export function InviteError({ error, reset }: ErrorComponentProps) {
  return (
    <div {...stylex.props(styles.ground)}>
      <RouteError error={error} reset={reset} fallback="Invalid or expired invite link" />
    </div>
  );
}

/**
 * L4: Show a confirmation screen before joining so accidental link clicks
 *     (e.g. shared in chat) don't silently add someone to a space.
 * M3: Error state offers a "Try again" button so users aren't stuck with only
 *     an escape back to Home when a transient failure occurs.
 */
export function InviteRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { token } = routeApi.useParams();

  const { data: preview } = useSuspenseQuery(invitePreviewQueryOptions(token));

  const joinMutation = useMutation({
    mutationFn: () => joinViaInvite({ data: { token } }),
    onSuccess: async (result) => {
      await evictSpaceQueryCache(queryClient, result.spaceId, result.slug);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.spaces.all(),
        exact: true,
        refetchType: "none",
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.threads() });
      await navigate({ to: "/space/$spaceSlug", params: { spaceSlug: result.slug } });
    },
  });

  if (joinMutation.isError) {
    const message = joinMutation.error instanceof Error
      ? joinMutation.error.message
      : "Failed to join Space";

    return (
      <div {...stylex.props(styles.errorStack)}>
        <p {...stylex.props(styles.errorMessage)}>{message}</p>
        <div {...stylex.props(styles.errorActions)}>
          {/* M3: retry button so users aren't stuck after a transient failure */}
          <Button onClick={() => joinMutation.mutate()}>
            Try again
          </Button>
          <Button variant="secondary" onClick={() => { void navigate({ to: "/home" }); }}>
            Go Home
          </Button>
        </div>
      </div>
    );
  }

  if (joinMutation.isPending || joinMutation.isSuccess) {
    return (
      <div {...stylex.props(styles.ground)}>
        <div {...stylex.props(styles.pendingColumn)}>
          <Spinner size="lg" brand sx={styles.pendingSpinner} />
          <p {...stylex.props(styles.pendingText)}>Joining Space...</p>
        </div>
      </div>
    );
  }

  // L4: Confirmation screen — shown before any join request is fired
  return (
    // The same frame as signing in: someone arriving from a link meets the
    // product's own ground and mark first, then the one question.
    <AuthLayout>
      <div>
        <p {...stylex.props(styles.eyebrow)}>You’re invited to</p>
        <h1 {...stylex.props(styles.title)}>{preview.spaceName}</h1>
        <p {...stylex.props(styles.detail)}>
          Joining gives you its past meetings, boards and files, and a seat in its next meeting.
        </p>
        <div {...stylex.props(styles.actions)}>
          <Button sx={styles.action} onClick={() => joinMutation.mutate()}>
            Join {preview.spaceName}
          </Button>
          <Button
            variant="secondary"
            sx={styles.action}
            onClick={() => {
              void navigate({ to: "/home" });
            }}
          >
            Not now
          </Button>
        </div>
      </div>
    </AuthLayout>
  );
}

import {
  useInfiniteQuery,
} from "@tanstack/react-query";
import {
  spaceAuditEventsInfiniteQueryOptions,
} from "@/app/query-client/queries/spaces";
import { Button } from "@orbmeet/ui/react";
import { QueryErrorNotice } from "@/app/query-client/query-error-notice";
import {
  History,
} from "lucide-react";
import { status } from "@orbmeet/ui/styles/atoms";
import { ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { panelStyles } from "./space-panel-styles";

const styles = stylex.create({

  /* ── Activity ──────────────────────────────────────────────────────────── */
  activityTitle: {
    margin: 0,
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.base,
    lineHeight: leading.base,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  activityList: {
    marginTop: space.s3,
    marginBottom: 0,
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    listStyleType: "none",
    padding: 0,
  },
  activityRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: surface.raised,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontSize: text.sm,
  },
  activityText: { color: neutral.n700 },
  activityTime: { flexShrink: 0, fontSize: text.xs, color: ink.muted },
  activityMore: { paddingTop: space.s1, textAlign: "center" },
});

type AuditEvent = Awaited<ReturnType<typeof import("@/modules/spaces/server/audit.functions").listSpaceAuditEvents>>["events"][number];

function describeAuditEvent(e: AuditEvent): string {
  const actor = e.actorName ?? "Someone";
  const target = e.targetName ?? "a member";
  let role: string | undefined;
  let via: string | undefined;
  if (e.metadata) {
    try {
      const meta = JSON.parse(e.metadata) as { role?: string; to?: string; via?: string };
      role = meta.to ?? meta.role;
      via = meta.via;
    } catch {
      // metadata is best-effort display context; ignore malformed JSON.
    }
  }
  switch (e.action) {
    case "member_added":
      if (via === "invite") return `${actor} joined via invite${role ? ` as ${role}` : ""}`;
      return `${actor} added ${target}${role ? ` as ${role}` : ""}`;
    case "member_removed":
      return `${actor} removed ${target}`;
    case "member_left":
      return `${actor} left the space`;
    case "role_changed":
      return `${actor} changed ${target}'s role${role ? ` to ${role}` : ""}`;
    case "ownership_transferred":
      return `${actor} transferred ownership to ${target}`;
    case "invite_created":
      return `${actor} created an invite${role ? ` (${role})` : ""}`;
    case "invite_revoked":
      return `${actor} revoked an invite`;
    case "invite_downgraded":
      return `${target}'s invite was downgraded to member`;
    case "invite_rotated":
      return `${actor} replaced the Space invitation URL`;
    default:
      return `${actor} performed ${String(e.action)}`;
  }
}

export function ActivityPanel({ spaceId }: { spaceId: string }) {
  const query = useInfiniteQuery(spaceAuditEventsInfiniteQueryOptions(spaceId));
  const events = query.data?.pages.flatMap((p) => p.events) ?? [];

  return (
    <div>
      <h3 {...stylex.props(styles.activityTitle)}>
        <History size={16} {...stylex.props(panelStyles.activityGlyph)} />
        Activity
      </h3>
      <p {...stylex.props(panelStyles.panelNote)}>
        Membership and invite changes in this space.
      </p>

      {query.isLoading ? (
        <p {...stylex.props(status.hint)}>Loading…</p>
      ) : query.isError ? (
        <QueryErrorNotice
          message="Activity could not be loaded."
          onRetry={() => { void query.refetch(); }}
sx={panelStyles.spacedTop}
        />
      ) : events.length === 0 ? (
        <p {...stylex.props(status.hint)}>No activity yet.</p>
      ) : (
        <ul {...stylex.props(styles.activityList)}>
          {events.map((e) => (
            <li
              key={e.id}
              {...stylex.props(styles.activityRow)}
            >
              <span {...stylex.props(styles.activityText)}>{describeAuditEvent(e)}</span>
              <span {...stylex.props(styles.activityTime)}>
                {new Date(e.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
          {query.hasNextPage && (
            <li {...stylex.props(styles.activityMore)}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void query.fetchNextPage();
                }}
                loading={query.isFetchingNextPage}
              >
                Load more
              </Button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

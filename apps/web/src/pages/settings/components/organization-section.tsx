import { Link } from "@tanstack/react-router";
import { type QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Select,
  Spinner,
} from "@orbmeet/ui/react";
import { layout, row, stack } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { bp, env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { ArrowRightLeft, Check, ExternalLink, Trash2, UserPlus, X } from "lucide-react";
import * as React from "react";

import {
  myOrganizationsQueryOptions,
  organizationMembersInfiniteQueryOptions,
  organizationSpacesQueryOptions,
} from "@/modules/organizations/client/organizations.queries";
import { planPricesQueryOptions } from "@/modules/billing/client/plan-prices.queries";
import { QueryErrorNotice } from "@orbmeet/ui/react";
import { logError } from "@/lib/logger";
import { queryKeys } from "@/lib/query-keys";
import { openBillingPortal, startSubscriptionCheckout } from "@/modules/billing/client/billing-client";
import { isPaymentFailing, PaymentFailedNotice } from "@/modules/billing/client/payment-failed-notice";
import { DEFAULT_PLAN_PRICES, formatPlanPrice } from "@/modules/billing/contract/plan-prices";
import type { SubscriptionStatus } from "@/modules/billing/contract/types";
import type { OrganizationRole } from "@/modules/organizations/contract/roles";
import {
  acceptOrganizationOwnershipTransfer,
  addOrganizationMember,
  createOrganization,
  declineOrganizationOwnershipTransfer,
  removeOrganizationMember,
  transferOrganizationOwnership,
} from "@/modules/organizations/server/organizations.functions";
import { evictSpaceQueryCache } from "@/modules/spaces/client/space-query-cache";
import { deleteSpace } from "@/workflows/space-deletion/delete-space.functions";
import { settings } from "../settings-styles";
import { SettingsSection } from "./settings-section";

const styles = stylex.create({
  transfers: { marginBottom: space.s6 },
  /** An ownership request: a notice you have to answer, not one you dismiss. */
  transfer: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: warning.w200,
    backgroundColor: warning.w50,
    padding: space.s4,
  },
  transferTitle: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  transferBody: {
    marginTop: space.s1,
    marginBottom: 0,
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: ink.body,
  },
  transferActions: { marginTop: space.s3 },
  iconButton: { gap: space.s1_5 },

  /** A field row that stacks on a phone and lines up once there is room. */
  fieldRow: {
    display: "flex",
    flexDirection: { default: "column", [bp.sm]: "row" },
    alignItems: { default: "stretch", [bp.sm]: "flex-end" },
    gap: space.s3,
  },
  /** Lifts a button to the baseline of the labelled field beside it. */
  alignToField: { paddingTop: { default: 0, [bp.sm]: space.s7 } },
  planMeta: { paddingBottom: space.s2 },
  planMetaText: { fontSize: text.sm, lineHeight: leading.sm, color: ink.muted },
  billing: { alignItems: "center", flexWrap: "wrap" },
  statusBadge: { textTransform: "capitalize" },
  licenceNote: {
    margin: 0,
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: ink.muted,
  },

  /** Email + role + submit, side by side once the row is wide enough. */
  addMemberGrid: {
    display: "grid",
    gap: space.s3,
    gridTemplateColumns: { default: "1fr", [bp.md]: "1fr 180px auto" },
    alignItems: { default: "stretch", [bp.md]: "end" },
  },

  spaceLink: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: { default: ink.strong, [env.hoverable]: { default: ink.strong, ":hover": accent.a700 } },
    textDecorationLine: "none",
  },
  rowName: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: ink.strong,
  },
  rowMeta: {
    margin: 0,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },
  destructive: { color: danger.d600 },
  loadMore: { paddingTop: space.s2, textAlign: "center" },

  /** An empty state that has to sit in the same box the list would. */
  emptyBox: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    padding: space.s4,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.muted,
  },

  dialogBody: { padding: space.s6 },
  dialogActions: { marginTop: space.s5, justifyContent: "flex-end" },
});

function invalidateOrganizationMembership(queryClient: QueryClient, organizationId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.organizations.members(organizationId) }),
  ]);
}

function roleLabel(role: OrganizationRole): string {
  if (role === "owner") return "Organization owner";
  if (role === "admin") return "Organization admin";
  return "Organization member";
}

interface OrganizationBillingSummary {
  plan: "organization" | "free";
  subscriptionStatus: SubscriptionStatus;
  seats: number | null;
  cancelAtPeriodEnd: boolean | null;
}

/**
 * The Organization's own subscription: its owner subscribes, or manages a
 * running subscription in the billing portal. Everyone else sees its state.
 */
function OrganizationBilling({
  organizationId,
  isOwner,
  billing,
}: {
  organizationId: string;
  isOwner: boolean;
  billing: OrganizationBillingSummary;
}) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const running = billing.subscriptionStatus !== null;
  const { data: prices = DEFAULT_PLAN_PRICES } = useQuery(planPricesQueryOptions());
  const seatPrice = `${formatPlanPrice(prices.organizationSeat)} per member/mo${prices.taxAddedAtCheckout ? " + tax" : ""}`;

  async function act() {
    setLoading(true);
    setError(null);
    try {
      if (running) await openBillingPortal({ organizationId });
      else await startSubscriptionCheckout({ plan: "organization", organizationId });
    } catch (err) {
      logError("[settings] Organization billing failed", err);
      setError("Something went wrong. Please try again or contact support.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div {...stylex.props(stack.x2)}>
      <PaymentFailedNotice status={billing.subscriptionStatus} customer="organization" canUpdate={isOwner} />
      <div {...stylex.props(row.x2, styles.billing)}>
        {billing.subscriptionStatus && billing.subscriptionStatus !== "active" && (
          <Badge variant="warning" sx={styles.statusBadge}>
            {billing.subscriptionStatus.replace("_", " ")}
          </Badge>
        )}
        <span {...stylex.props(styles.planMetaText)}>
          {billing.plan === "organization"
            ? `Billed for ${billing.seats ?? 0} ${billing.seats === 1 ? "member" : "members"}${billing.cancelAtPeriodEnd ? " · ends at the period's end" : ""}`
            : "Not subscribed: Free limits, and no members can be added until the owner subscribes."}
        </span>
      </div>
      {isOwner ? (
        <div>
          <Button variant="secondary" sx={styles.iconButton} onClick={() => { void act(); }} disabled={loading}>
            {running ? <><ExternalLink size={14} /> {loading ? "Opening..." : isPaymentFailing(billing.subscriptionStatus) ? "Update payment method" : "Manage billing"}</> : loading ? "Loading..." : `Subscribe — ${seatPrice}`}
          </Button>
        </div>
      ) : (
        <p {...stylex.props(settings.blurb)}>The Organization's owner manages its billing.</p>
      )}
      {error && <p {...stylex.props(settings.error, settings.errorFlush)}>{error}</p>}
    </div>
  );
}

export function OrganizationSection() {
  const queryClient = useQueryClient();
  const organizationsQuery = useQuery(myOrganizationsQueryOptions());
  // Memoize so the empty-data fallback doesn't allocate a new array each render
  // and retrigger the selection effect below.
  const organizations = React.useMemo(
    () => organizationsQuery.data?.organizations ?? [],
    [organizationsQuery.data],
  );
  const ownershipTransfers = organizationsQuery.data?.ownershipTransfers ?? [];
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selectedOrganization = organizations.find((org) => org.id === selectedId) ?? organizations[0] ?? null;

  const [name, setName] = React.useState("");
  const createMutation = useMutation({
    mutationFn: () => createOrganization({ data: { name } }),
    onSuccess: async (result) => {
      setName("");
      setSelectedId(result.organizationId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all() });
    },
  });
  const acceptTransferMutation = useMutation({
    mutationFn: (organizationId: string) =>
      acceptOrganizationOwnershipTransfer({ data: { organizationId } }),
    onSuccess: async () => {
      setSelectedId(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all() });
    },
  });
  const declineTransferMutation = useMutation({
    mutationFn: (organizationId: string) =>
      declineOrganizationOwnershipTransfer({ data: { organizationId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all() });
    },
  });

  if (organizationsQuery.isPending) {
    return (
      <SettingsSection title="Organization">
        <div {...stylex.props(settings.loading)}><Spinner size="sm" /></div>
      </SettingsSection>
    );
  }

  if (organizationsQuery.isError) {
    return (
      <SettingsSection title="Organization">
        <QueryErrorNotice
          message="Organizations could not be loaded."
          onRetry={() => { void organizationsQuery.refetch(); }}
        />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Organization">
      {ownershipTransfers.length > 0 && (
        <div {...stylex.props(stack.x3, styles.transfers)}>
          {ownershipTransfers.map((transfer) => (
            <div
              key={transfer.organizationId}
              {...stylex.props(styles.transfer)}
            >
              <p {...stylex.props(styles.transferTitle)}>
                Ownership request for {transfer.organizationName}
              </p>
              <p {...stylex.props(styles.transferBody)}>
                {transfer.requestedByName} nominated you as owner. Accepting makes you
                responsible for the Organization and its billing. The request
                expires {new Date(transfer.expiresAt).toLocaleString()}.
              </p>
              <div {...stylex.props(row.x2, styles.transferActions)}>
                <Button
                  size="sm"
                  sx={styles.iconButton}
                  loading={
                    acceptTransferMutation.isPending
                    && acceptTransferMutation.variables === transfer.organizationId
                  }
                  disabled={acceptTransferMutation.isPending || declineTransferMutation.isPending}
                  onClick={() => acceptTransferMutation.mutate(transfer.organizationId)}
                >
                  <Check size={14} /> Accept ownership
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  sx={styles.iconButton}
                  loading={
                    declineTransferMutation.isPending
                    && declineTransferMutation.variables === transfer.organizationId
                  }
                  disabled={acceptTransferMutation.isPending || declineTransferMutation.isPending}
                  onClick={() => declineTransferMutation.mutate(transfer.organizationId)}
                >
                  <X size={14} /> Decline
                </Button>
              </div>
              {(acceptTransferMutation.isError || declineTransferMutation.isError) && (
                <p {...stylex.props(settings.error)}>
                  The ownership request could not be updated. Please try again.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {organizations.length === 0 ? (
        <div {...stylex.props(stack.x4)}>
          <p {...stylex.props(settings.blurb)}>
            Create an Organization for shared billing, member roles and Organization-funded Spaces. Once subscribed, it is billed per member: one seat for each person in it.
          </p>
          <div {...stylex.props(styles.fieldRow)}>
            <Input
              label="Organization name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={createMutation.isPending}
              placeholder="Acme Studio"
            />
            <div {...stylex.props(styles.alignToField)}>
              <Button
                type="button"
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !name.trim()}
              >
                {createMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </div>
          </div>
          {createMutation.error && (
            <p {...stylex.props(settings.error, settings.errorFlush)}>
              {createMutation.error instanceof Error ? createMutation.error.message : "Failed to create organization."}
            </p>
          )}
        </div>
      ) : (
        <div {...stylex.props(stack.x6)}>
          <div {...stylex.props(styles.fieldRow)}>
            <Select
              label="Organization"
              value={selectedOrganization?.id}
              onValueChange={(value) => setSelectedId(value)}
              options={organizations.map((org) => ({ label: org.name, value: org.id }))}
            />
            <div {...stylex.props(row.x2, styles.planMeta)}>
              <Badge variant="primary">{roleLabel((selectedOrganization?.role ?? "member"))}</Badge>
            </div>
          </div>

          {selectedOrganization && (
            <OrganizationBilling
              organizationId={selectedOrganization.id}
              isOwner={selectedOrganization.role === "owner"}
              billing={selectedOrganization.billing}
            />
          )}

          <p {...stylex.props(styles.licenceNote)}>
            A license lets a person be assigned to Organization-funded Spaces. It does not reveal content: people still need direct membership in each Space they use.
          </p>

          {selectedOrganization && (
            <>
              {(selectedOrganization.role === "owner" || selectedOrganization.role === "admin") && (
                <OrganizationSpaces organizationId={selectedOrganization.id} />
              )}
              <OrganizationMembers organizationId={selectedOrganization.id} role={selectedOrganization.role} />
            </>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

function OrganizationSpaces({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient();
  const spacesQuery = useQuery(organizationSpacesQueryOptions(organizationId));
  const [deleteTarget, setDeleteTarget] = React.useState<{
    id: string;
    name: string;
    slug: string;
  } | null>(null);
  const deleteMutation = useMutation({
    mutationFn: (space: { id: string; slug: string }) =>
      deleteSpace({ data: { spaceId: space.id } }),
    onSuccess: async (_, space) => {
      setDeleteTarget(null);
      // Evict before invalidating, not alongside: a refetch kicked off by the
      // invalidation can resolve after removeQueries and write the deleted
      // space back into the cache.
      await evictSpaceQueryCache(queryClient, space.id, space.slug);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.organizations.spaces(organizationId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.threads() }),
      ]);
    },
  });

  return (
    <div {...stylex.props(stack.x3)}>
      <div>
        <h3 {...stylex.props(settings.subhead)}>Spaces billed to this Organization</h3>
        <p {...stylex.props(settings.fine)}>
          Billing administrators govern payment and deletion. They do not receive Meeting, Whiteboard, or file access without Space membership.
        </p>
      </div>
      {spacesQuery.isPending ? (
        <div {...stylex.props(settings.loading, settings.loadingShort)}><Spinner size="sm" /></div>
      ) : spacesQuery.isError ? (
        <QueryErrorNotice
          message="Organization-billed Spaces could not be loaded."
          onRetry={() => { void spacesQuery.refetch(); }}
        />
      ) : spacesQuery.data.spaces.length === 0 ? (
        <div {...stylex.props(styles.emptyBox)}>
          No Spaces are billed to this Organization yet.
        </div>
      ) : (
        <div {...stylex.props(settings.list)}>
          {spacesQuery.data.spaces.map((space, index) => (
            <div
              key={space.id}
              {...stylex.props(settings.listRow, index === 0 && settings.listRowFirst)}
            >
              <div {...stylex.props(layout.minZero)}>
                {space.viewerRole ? (
                  <Link
                    to="/space/$spaceSlug"
                    params={{ spaceSlug: space.slug }}
                    {...stylex.props(styles.spaceLink, layout.truncate)}
                  >
                    {space.name}<ExternalLink size={12} />
                  </Link>
                ) : (
                  <p {...stylex.props(styles.rowName, layout.truncate)}>{space.name}</p>
                )}
                <p {...stylex.props(styles.rowMeta)}>
                  {space.memberCount} member{space.memberCount === 1 ? "" : "s"}
                  {space.viewerRole ? ` · ${space.viewerRole === "admin" ? "Space admin" : "Space member"}` : " · No content access"}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                sx={styles.destructive}
                onClick={() =>
                  setDeleteTarget({ id: space.id, name: space.name, slug: space.slug })
                }
              >
                <Trash2 size={14} /> Delete
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent size="sm">
          <DialogBody sx={styles.dialogBody}>
            <DialogTitle>Delete Organization-billed Space?</DialogTitle>
            <DialogDescription>
              Deleting “{deleteTarget?.name}” permanently removes its membership, Meetings and their outputs, Whiteboards, Files, and activity history. This cannot be undone.
            </DialogDescription>
            <div {...stylex.props(row.x3, styles.dialogActions)}>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button
                variant="danger"
                loading={deleteMutation.isPending}
                onClick={() => {
                  if (deleteTarget) deleteMutation.mutate(deleteTarget);
                }}
              >
                Delete Space
              </Button>
            </div>
            {deleteMutation.isError && (
              <p {...stylex.props(settings.error)}>Failed to delete the Space.</p>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OrganizationMembers({
  organizationId,
  role,
}: {
  organizationId: string;
  role: OrganizationRole;
}) {
  const queryClient = useQueryClient();
  const membersQuery = useInfiniteQuery(organizationMembersInfiniteQueryOptions(organizationId));
  const members = membersQuery.data?.pages.flatMap((page) => page.members) ?? [];
  const canAddMembers = role === "owner" || role === "admin";
  const canAddAdmins = role === "owner";
  const [email, setEmail] = React.useState("");
  const [newMemberRole, setNewMemberRole] = React.useState<"admin" | "member">("member");
  const [transferTarget, setTransferTarget] = React.useState<{
    userId: string;
    name: string;
  } | null>(null);

  const addMemberMutation = useMutation({
    mutationFn: () => addOrganizationMember({ data: { organizationId, email, role: newMemberRole } }),
    onSuccess: async () => {
      setEmail("");
      setNewMemberRole("member");
      await invalidateOrganizationMembership(queryClient, organizationId);
    },
  });
  const transferMutation = useMutation({
    mutationFn: (newOwnerUserId: string) =>
      transferOrganizationOwnership({ data: { organizationId, newOwnerUserId } }),
    onSuccess: async () => {
      setTransferTarget(null);
      await invalidateOrganizationMembership(queryClient, organizationId);
    },
  });
  const removeMemberMutation = useMutation({
    mutationFn: (memberUserId: string) =>
      removeOrganizationMember({ data: { organizationId, memberUserId } }),
    onSuccess: async () => {
      await invalidateOrganizationMembership(queryClient, organizationId);
    },
  });

  if (membersQuery.isPending) {
    return <div {...stylex.props(settings.loading)}><Spinner size="sm" /></div>;
  }

  if (membersQuery.isError) {
    return (
      <QueryErrorNotice
        message="Organization members could not be loaded."
        onRetry={() => { void membersQuery.refetch(); }}
      />
    );
  }

  return (
    <div {...stylex.props(stack.x4)}>
      {canAddMembers && (
        <div {...stylex.props(settings.formPanel)}>
          <div {...stylex.props(styles.addMemberGrid)}>
            <Input
              label="Add a member by email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="member@company.com"
              disabled={addMemberMutation.isPending}
            />
            <Select
              label="Role"
              value={newMemberRole}
              onValueChange={(value) => setNewMemberRole(value === "admin" ? "admin" : "member")}
              options={[
                { label: "Member", value: "member" },
                { label: "Administrator", value: "admin", disabled: !canAddAdmins },
              ]}
              disabled={addMemberMutation.isPending}
            />
            <Button
              type="button"
              sx={styles.iconButton}
              onClick={() => addMemberMutation.mutate()}
              disabled={addMemberMutation.isPending || !email.trim()}
            >
              <UserPlus size={16} />
              {addMemberMutation.isPending ? "Adding..." : "Add"}
            </Button>
          </div>
          {addMemberMutation.error && (
            <p {...stylex.props(settings.error)}>
              {addMemberMutation.error instanceof Error ? addMemberMutation.error.message : "Failed to add member."}
            </p>
          )}
        </div>
      )}

      <div {...stylex.props(settings.list)}>
        {members.map((member, index) => (
          <div
            key={member.id}
            {...stylex.props(settings.listRow, index === 0 && settings.listRowFirst)}
          >
            <div {...stylex.props(layout.minZero)}>
              <p {...stylex.props(styles.rowName, layout.truncate)}>{member.user.name}</p>
              <p {...stylex.props(styles.rowMeta, layout.truncate)}>{member.user.email}</p>
            </div>
            <div {...stylex.props(row.x2)}>
              <Badge variant={member.role === "owner" ? "primary" : member.role === "admin" ? "warning" : "default"}>
                {roleLabel(member.role)}
              </Badge>
              {role === "owner" && member.role !== "owner" && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setTransferTarget({ userId: member.userId, name: member.user.name })}
                >
                  <ArrowRightLeft size={14} /> Transfer ownership
                </Button>
              )}
              {member.role !== "owner" && (role === "owner" || (role === "admin" && member.role === "member")) && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={removeMemberMutation.isPending}
                  onClick={() => removeMemberMutation.mutate(member.userId)}
                  aria-label={`Remove ${member.user.name} from the Organization`}
                >
                  <Trash2 size={14} /> Remove
                </Button>
              )}
            </div>
          </div>
        ))}
        {members.length === 0 && (
          <div {...stylex.props(settings.listEmpty)}>No members yet.</div>
        )}
      </div>

      {membersQuery.hasNextPage && (
        <div {...stylex.props(styles.loadMore)}>
          <Button
            variant="secondary"
            size="sm"
            loading={membersQuery.isFetchingNextPage}
            onClick={() => { void membersQuery.fetchNextPage(); }}
          >
            Load more
          </Button>
        </div>
      )}

      {removeMemberMutation.error && (
        <p {...stylex.props(settings.error, settings.errorFlush)}>
          {removeMemberMutation.error instanceof Error
            ? removeMemberMutation.error.message
            : "Failed to remove member."}
        </p>
      )}

      <Dialog
        open={Boolean(transferTarget)}
        onOpenChange={(open) => { if (!open) setTransferTarget(null); }}
      >
        <DialogContent size="sm">
          <DialogBody sx={styles.dialogBody}>
            <DialogTitle>Transfer organization ownership?</DialogTitle>
            <DialogDescription>
              Send an ownership request to {transferTarget?.name}. Ownership, including
              managing the Organization’s billing, moves to them once they accept. Its
              subscription stays as it is. You become a member once they accept; they can make
              you an administrator again.
            </DialogDescription>
            <div {...stylex.props(row.x3, styles.dialogActions)}>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button
                loading={transferMutation.isPending}
                onClick={() => {
                  if (transferTarget) transferMutation.mutate(transferTarget.userId);
                }}
              >
                Send request
              </Button>
            </div>
            {transferMutation.isError && (
              <p {...stylex.props(settings.error)}>
                {transferMutation.error instanceof Error
                  ? transferMutation.error.message
                  : "Failed to transfer organization ownership."}
              </p>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

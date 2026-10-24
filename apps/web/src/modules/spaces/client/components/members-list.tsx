import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { removeMember, addMemberByEmail, updateMemberRole, transferOwnership } from "@/modules/spaces/server/membership.functions";
import { rotateSpaceInvite } from "@/modules/spaces/server/invites.functions";
import { spaceInviteQueryOptions } from "@/app/query-client/queries/spaces";
import type { SpaceMemberSummary } from "@/modules/spaces/contract/types";
import { spaceRoleBadgeVariant } from "@/modules/spaces/client/space-role-badge";
import { getSpaceAccessLabel } from "@/modules/spaces/space-access";
import { queryKeys } from "@/app/query-client/query-keys";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { Avatar } from "@orbmeet/ui/react";
import { Badge } from "@orbmeet/ui/react";
import { Button } from "@orbmeet/ui/react";
import { Input } from "@orbmeet/ui/react";
import { EmptyState } from "@orbmeet/ui/react";
import { QueryErrorNotice } from "@/app/query-client/query-error-notice";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@orbmeet/ui/react";
import { dialogLayout } from "@orbmeet/ui/react";
import { layout, motion, pressable, row, stack, status } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, success, surface, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  ArrowRightLeft,
  Check,
  Copy,
  Link2,
  RotateCcw,
  Shield,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { env } from "@orbmeet/ui/tokens/media.stylex";

const styles = stylex.create({
  intro: {
    marginTop: 0,
    marginBottom: space.s4,
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: ink.muted,
  },
  banner: {
    marginBottom: space.s4,
    borderRadius: radii.field,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: danger.d200,
    backgroundColor: danger.d50,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: danger.d700,
  },
  adminTools: { marginBottom: space.s6 },
  loadMore: { paddingTop: space.s2, textAlign: "center" },

  /** A quiet inset panel: the invite link, the add-member form. */
  panel: {
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: neutral.n50,
    padding: space.s4,
  },
  panelTitle: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: ink.strong,
  },
  panelNote: {
    margin: 0,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },
  linkGlyph: {
    display: "flex",
    height: 36,
    width: 36,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.field,
    backgroundColor: accent.a50,
    color: accent.a600,
  },
  panelActions: { flexShrink: 0 },
  reset: { color: { default: ink.muted, [env.hoverable]: { default: ink.muted, ":hover:not(:disabled)": neutral.n600 } } },
  copied: { color: success.s600 },
  addForm: { marginTop: space.s3 },
  addField: { flexGrow: 1 },
  retry: { marginTop: space.s3 },

  /** One member. Its own card rather than a shared list, because it is a row
      you act on — the hover is the affordance for the buttons on its right. */
  member: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: { default: surface.raised, [env.hoverable]: { default: surface.raised, ":hover": neutral.n50 } },
    padding: space.s3,
  },
  memberName: {
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    fontWeight: weight.medium,
    color: ink.strong,
  },

  /**
   * The row's icon actions. Each one tints toward the consequence of pressing
   * it, so "remove" reads as destructive before it is read at all.
   */
  // Each action says what it does: a shield, a swap and a person-minus side
  // by side asked members to guess which one removed someone.
  iconAction: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.s1_5,
    minHeight: 32,
    borderRadius: radii.pill,
    paddingInline: space.s2_5,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: neutral.n500,
  },
  actionNeutral: {
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": neutral.n700 } },
  },
  actionTransfer: {
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": warning.w50 } },
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": warning.w600 } },
  },
  actionRemove: {
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": danger.d50 } },
    color: { default: neutral.n500, [env.hoverable]: { default: neutral.n500, ":hover": danger.d500 } },
  },

  /** The two-role explainer inside the role dialog. */
  roleExplainer: {
    marginTop: space.s4,
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    borderRadius: radii.field,
    backgroundColor: neutral.n50,
    padding: space.s3,
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: ink.body,
  },
  roleTerm: { color: neutral.n800 },
});

interface MembersListProps {
  spaceId: string;
  members: SpaceMemberSummary[];
  isAdmin: boolean;
  canGrantAdmins: boolean;
  canTransferOwnership: boolean;
  currentUserId: string;
  isOrganizationSpace: boolean;
  /** M2: members are paginated — these drive the "Load more" control. */
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}

export function MembersList({
  spaceId,
  members,
  isAdmin,
  canGrantAdmins,
  canTransferOwnership,
  currentUserId,
  isOrganizationSpace,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: MembersListProps) {
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <p {...stylex.props(styles.intro)}>
        Current members can open every past Meeting in this Space. After leaving
        or being removed, a signed-in person keeps only the past Meetings they
        actually joined.
        {isOrganizationSpace
          ? " Organization-funded Spaces can add only people with an Organization license."
          : ""}
      </p>
      {error && (
        <div {...stylex.props(styles.banner)}>
          {error}
        </div>
      )}

      {/* Admin actions */}
      {isAdmin && (
        <div {...stylex.props(stack.x4, styles.adminTools)}>
          <SpaceInvitationUrl spaceId={spaceId} isOrganizationSpace={isOrganizationSpace} />

          {/* Add member by email */}
          <AddMemberForm spaceId={spaceId} />
        </div>
      )}

      {/* Members list */}
      {members.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No members"
          description="Invite people to join this Space."
        />
      ) : (
        <div {...stylex.props(stack.x2)}>
          {members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              spaceId={spaceId}
              isAdmin={isAdmin}
              canGrantAdmins={canGrantAdmins}
              canTransferOwnership={canTransferOwnership}
              currentUserId={currentUserId}
              onError={setError}
            />
          ))}
          {hasMore && (
            <div {...stylex.props(styles.loadMore)}>
              <Button variant="secondary" size="sm" onClick={onLoadMore} loading={isLoadingMore}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SpaceInvitationUrl({
  spaceId,
  isOrganizationSpace,
}: {
  spaceId: string;
  isOrganizationSpace: boolean;
}) {
  const queryClient = useQueryClient();
  const inviteQuery = useQuery(spaceInviteQueryOptions(spaceId));
  const { copied, copy } = useCopyToClipboard();
  const [rotateOpen, setRotateOpen] = useState(false);
  const rotateMutation = useMutation({
    mutationFn: () => rotateSpaceInvite({ data: { spaceId } }),
    onSuccess: async (result) => {
      queryClient.setQueryData(queryKeys.spaces.invite(spaceId), result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.spaces.audit(spaceId) });
      setRotateOpen(false);
    },
  });

  const invitationPath = inviteQuery.data
    ? `/join/${inviteQuery.data.token}`
    : null;

  function handleCopy() {
    if (invitationPath) void copy(new URL(invitationPath, window.location.origin).toString());
  }

  return (
    <div {...stylex.props(styles.panel)}>
      <div {...stylex.props(row.x3)}>
        <div {...stylex.props(styles.linkGlyph)}>
          <Link2 size={16} />
        </div>
        <div {...stylex.props(layout.minZero)}>
          <p {...stylex.props(styles.panelTitle)}>Invite link</p>
          <p {...stylex.props(styles.panelNote)}>
            {isOrganizationSpace
              ? "Grants lasting membership to a licensed Organization user · valid until replaced"
              : "Grants lasting membership: members can enter Space Meetings and edit Space Whiteboards · valid until replaced"}
          </p>
        </div>
        <div {...stylex.props(row.x2, styles.panelActions)}>
          <Button
            size="sm"
            variant="secondary"
            disabled={!invitationPath || inviteQuery.isPending}
            onClick={handleCopy}
          >
            {copied ? <Check size={14} {...stylex.props(styles.copied)} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            sx={styles.reset}
            title="Reset invite link"
            aria-label="Reset invite link"
            onClick={() => setRotateOpen(true)}
          >
            <RotateCcw size={14} />
          </Button>
        </div>
      </div>

      {inviteQuery.isError && (
        <QueryErrorNotice
          message="The invite link could not be loaded."
          onRetry={() => { void inviteQuery.refetch(); }}
sx={styles.retry}
        />
      )}

      <Dialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <DialogContent size="sm">
          <DialogBody sx={dialogLayout.padded}>
            <DialogTitle>Reset invite link?</DialogTitle>
            <DialogDescription>
              The current link stops working immediately. Anyone you shared it with will need the new one.
            </DialogDescription>
            <div {...stylex.props(dialogLayout.actions)}>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button
                variant="danger"
                loading={rotateMutation.isPending}
                onClick={() => rotateMutation.mutate()}
              >
                Reset link
              </Button>
            </div>
            {rotateMutation.isError && (
              <p {...stylex.props(status.error)}>Failed to reset the invite link.</p>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------- Add Member by Email ---------- */

function AddMemberForm({ spaceId }: { spaceId: string }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [success, setSuccess] = useState<"added" | "existing" | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(successTimerRef.current), []);

  const mutation = useMutation({
    mutationFn: (memberEmail: string) =>
      addMemberByEmail({ data: { spaceId, email: memberEmail } }),
    onSuccess: async (result) => {
      setEmail("");
      // M2: show different message depending on whether the user was already a member
      setSuccess(result.alreadyMember ? "existing" : "added");
      clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setSuccess(null), 3000);
      if (!result.alreadyMember) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.spaces.members(spaceId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.spaces.detail(spaceId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all() }),
          queryClient.invalidateQueries({ queryKey: queryKeys.spaces.audit(spaceId) }),
        ]);
      }
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    mutation.mutate(email.trim());
  };

  return (
    <div {...stylex.props(styles.panel)}>
      <h3 {...stylex.props(styles.panelTitle)}>Add member directly</h3>
      <p {...stylex.props(styles.panelNote)}>
        Adds lasting membership with access to Space Meetings and outputs, Files, and editable Whiteboards.
      </p>
      <form onSubmit={handleSubmit} {...stylex.props(row.x2, styles.addForm)}>
        <Input
          aria-label="Member email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
          type="email"
sx={styles.addField}
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          loading={mutation.isPending}
          disabled={!email.trim()}
        >
          <UserPlus size={14} />
          Add
        </Button>
      </form>
      {success === "added" && (
        <p {...stylex.props(status.success, status.small)}>Member added.</p>
      )}
      {success === "existing" && (
        <p {...stylex.props(status.hint, status.small)}>Already a member.</p>
      )}
      {mutation.isError && (
        <p {...stylex.props(status.error, status.small)}>
          {mutation.error instanceof Error
            ? mutation.error.message
            : "Failed to add member."}
        </p>
      )}
    </div>
  );
}

/* ---------- Member Row ---------- */

function MemberRow({
  member,
  spaceId,
  isAdmin,
  canGrantAdmins,
  canTransferOwnership,
  currentUserId,
  onError,
}: {
  member: SpaceMemberSummary;
  spaceId: string;
  isAdmin: boolean;
  canGrantAdmins: boolean;
  canTransferOwnership: boolean;
  currentUserId: string;
  onError: (msg: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  // Removing someone was one click, with nothing between it and the deed.
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const isSelf = member.userId === currentUserId;

  const removeMutation = useMutation({
    mutationFn: () => removeMember({ data: { spaceId, userId: member.userId } }),
    onSuccess: async () => {
      onError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.members(spaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.detail(spaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.audit(spaceId) }),
      ]);
    },
    onError: () => {
      onError("Failed to remove member. Please try again.");
    },
  });

  const roleMutation = useMutation({
    mutationFn: (role: "admin" | "member") =>
      updateMemberRole({ data: { spaceId, userId: member.userId, role } }),
    onSuccess: async () => {
      setRoleDialogOpen(false);
      onError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.members(spaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.audit(spaceId) }),
      ]);
    },
    onError: () => {
      onError("Failed to update role. Please try again.");
    },
  });

  const transferMutation = useMutation({
    mutationFn: () => transferOwnership({ data: { spaceId, userId: member.userId } }),
    onSuccess: async () => {
      setTransferDialogOpen(false);
      onError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.members(spaceId) }),
        // The caller's own role flips owner→admin, so refresh space metadata too.
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.detail(spaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.audit(spaceId) }),
      ]);
    },
    onError: () => {
      onError("Failed to transfer ownership. Please try again.");
    },
  });

  const memberRole = member.role;

  const canRemove =
    !isSelf
    && memberRole !== "owner"
    && (memberRole === "member" ? isAdmin : canGrantAdmins);

  const canChangeRole = canGrantAdmins && memberRole !== "owner" && !isSelf;
  const canTransfer = canTransferOwnership && memberRole !== "owner" && !isSelf;

  return (
    <div {...stylex.props(styles.member, motion.tint)}>
      <div {...stylex.props(row.x3)}>
        <Avatar
          name={member.user?.name || "Unknown"}
          image={member.user?.image}
          size="sm"
        />
        <div>
          <p {...stylex.props(styles.memberName)}>{member.user?.name || "Unknown"}</p>
        </div>
      </div>
      <div {...stylex.props(row.x2)}>
        <Badge variant={spaceRoleBadgeVariant[member.role]}>
          {getSpaceAccessLabel({ directRole: member.role })}
        </Badge>

        {/* F2: promote/demote button */}
        {canChangeRole && (
          <button
            onClick={() => setRoleDialogOpen(true)}
            {...stylex.props(pressable.base, motion.tint, styles.iconAction, styles.actionNeutral)}
            title="Change role"
            aria-label="Change member role"
          >
            <Shield size={14} aria-hidden="true" />
            Role
          </button>
        )}

        {/* F1: transfer ownership button */}
        {canTransfer && (
          <button
            onClick={() => setTransferDialogOpen(true)}
            {...stylex.props(pressable.base, motion.tint, styles.iconAction, styles.actionTransfer)}
            title="Transfer ownership"
            aria-label="Transfer ownership to this member"
          >
            <ArrowRightLeft size={14} aria-hidden="true" />
            Make owner
          </button>
        )}

        {/* H1: Remove button shown only when the caller has permission to remove this specific member */}
        {canRemove && (
          <button
            type="button"
            onClick={() => setRemoveDialogOpen(true)}
            disabled={removeMutation.isPending}
            {...stylex.props(pressable.base, motion.tint, styles.iconAction, styles.actionRemove)}
            aria-label={`Remove ${member.user?.name || "this member"}`}
          >
            <UserMinus size={14} aria-hidden="true" />
            Remove
          </button>
        )}
      </div>

      {/* F2: Role change dialog */}
      <Dialog open={roleDialogOpen} onOpenChange={setRoleDialogOpen}>
        <DialogContent size="sm">
          <DialogBody sx={dialogLayout.padded}>
            <DialogTitle>Change role</DialogTitle>
            <DialogDescription>
              Update the role for{" "}
              <strong>{member.user?.name || "this member"}</strong>.
            </DialogDescription>
            <div {...stylex.props(styles.roleExplainer)}>
              <p>
                <strong {...stylex.props(styles.roleTerm)}>Member:</strong> can enter and start
                Space Meetings, and create, rename, and edit Space Whiteboards.
              </p>
              <p>
                <strong {...stylex.props(styles.roleTerm)}>Admin:</strong> also manages people,
                Space settings, schedules, and Meeting controls.
              </p>
            </div>
            <div {...stylex.props(dialogLayout.actionsStacked)}>
              <Button
                variant={member.role === "admin" ? "secondary" : "primary"}
                onClick={() => roleMutation.mutate("admin")}
                loading={roleMutation.isPending}
                disabled={member.role === "admin"}
              >
                Promote to Admin
              </Button>
              <Button
                variant={member.role === "member" ? "secondary" : "outline"}
                onClick={() => roleMutation.mutate("member")}
                loading={roleMutation.isPending}
                disabled={member.role === "member"}
              >
                Demote to Member
              </Button>
              {/* Dialog.Root is modal, so a Dialog.Close has to render inside
                  the popup — it is the only exit a touch screen reader has. */}
              <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            </div>
            {roleMutation.isError && (
              <p {...stylex.props(status.error)}>
                Failed to update role. Please try again.
              </p>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* F1: Transfer ownership dialog */}
      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent size="sm">
          <DialogBody sx={dialogLayout.padded}>
            <DialogTitle>Remove {member.user?.name || "this member"}?</DialogTitle>
            <DialogDescription>
              They lose access to this Space’s Meetings, Whiteboards and Files. They keep only the past
              Meetings they joined themselves.
            </DialogDescription>
            <div {...stylex.props(dialogLayout.actions)}>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button
                variant="danger"
                onClick={() => removeMutation.mutate(undefined, { onSuccess: () => setRemoveDialogOpen(false) })}
                loading={removeMutation.isPending}
              >
                Remove
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog open={transferDialogOpen} onOpenChange={setTransferDialogOpen}>
        <DialogContent size="sm">
          <DialogBody sx={dialogLayout.padded}>
            <DialogTitle>Transfer ownership</DialogTitle>
            <DialogDescription>
              Transfer ownership to{" "}
              <strong>{member.user?.name || "this member"}</strong>? You will
              become an admin. This cannot be undone without their cooperation.
            </DialogDescription>
            <div {...stylex.props(dialogLayout.actions)}>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button
                variant="danger"
                onClick={() => transferMutation.mutate()}
                loading={transferMutation.isPending}
              >
                Transfer Ownership
              </Button>
            </div>
            {transferMutation.isError && (
              <p {...stylex.props(status.error)}>
                Failed to transfer ownership. Please try again.
              </p>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

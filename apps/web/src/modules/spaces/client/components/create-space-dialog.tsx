import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createSpace } from "@/modules/spaces/server/crud.functions";
import { getErrorMessage } from "@/lib/error-inspection";
import { queryKeys } from "@/app/query-client/query-keys";
import { myOrganizationsQueryOptions } from "@/app/query-client/queries/organizations";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  dialogLayout,
  Input,
  Select,
} from "@orbmeet/ui/react";
import { row, stack, status } from "@orbmeet/ui/styles/atoms";
import { danger, ink } from "@orbmeet/ui/tokens/colors.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  form: { marginTop: space.s5 },
  billingNote: {
    margin: 0,
    fontSize: text.xs,
    lineHeight: leading.xs,
    color: ink.muted,
  },
  createError: { color: danger.d600 },
  actions: { paddingTop: space.s2, justifyContent: "flex-end" },
});

interface CreateSpaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Creating a Space, from wherever it is offered — the rail's "+" beside
 * Spaces, and the Spaces page. A created Space opens at once: the next thing
 * anyone does with a new Space is invite someone or meet in it.
 */
export function CreateSpaceDialog({ open, onOpenChange }: CreateSpaceDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [organizationId, setOrganizationId] = useState("personal");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Only billing needs the organizations, and only someone who manages one
  // sees the choice, so the dialog asks for them only while it is open.
  const { data: organizationsData } = useQuery({ ...myOrganizationsQueryOptions(), enabled: open });
  const managedOrganizations = (organizationsData?.organizations ?? []).filter(
    (organization) => organization.role === "owner" || organization.role === "admin",
  );

  const createMutation = useMutation({
    mutationFn: (input: { name: string; description?: string; organizationId?: string; timeZone: string }) =>
      createSpace({ data: input }),
    onSuccess: async (created) => {
      onOpenChange(false);
      setName("");
      setDescription("");
      setOrganizationId("personal");
      if (created?.slug) await navigate({ to: "/space/$spaceSlug", params: { spaceSlug: created.slug } });
    },
    onSettled: async (_data, _error, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.threads() }),
        ...(variables.organizationId
          ? [queryClient.invalidateQueries({ queryKey: queryKeys.organizations.spaces(variables.organizationId) })]
          : []),
      ]);
    },
  });

  function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      organizationId: organizationId === "personal" ? undefined : organizationId,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogBody sx={dialogLayout.padded}>
          <DialogTitle>New space</DialogTitle>
          <DialogDescription>
            A place for the people you meet with again and again. Its meetings, boards and recaps stay together, and
            its members can meet in it any time.
          </DialogDescription>
          <form onSubmit={handleCreate} {...stylex.props(stack.x4, styles.form)}>
            <Input
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Weekly design review"
              required
              autoFocus
            />
            <Input
              label="Description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What is this space for? (optional)"
            />
            {managedOrganizations.length > 0 && (
              <Select
                label="Billing"
                value={organizationId}
                onValueChange={(value) => setOrganizationId(value ?? "personal")}
                options={[
                  { label: "Personal plan", value: "personal" },
                  ...managedOrganizations.map((org) => ({ label: `Billed to ${org.name}`, value: org.id })),
                ]}
              />
            )}
            {organizationId !== "personal" && (
              <p {...stylex.props(styles.billingNote)}>
                The billing organization pays for this space and governs deletion. Its members do not automatically
                receive content access.
              </p>
            )}
            {createMutation.error && (
              <p {...stylex.props(status.error, status.flush, styles.createError)}>
                {getErrorMessage(createMutation.error, "Couldn’t create the space")}
              </p>
            )}
            <div {...stylex.props(row.x3, styles.actions)}>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button type="submit" loading={createMutation.isPending} disabled={!name.trim()}>
                Create space
              </Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

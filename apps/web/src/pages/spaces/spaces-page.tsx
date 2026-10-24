import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { mySpacesQueryOptions } from "@/app/query-client/queries/spaces";
import { Button, EmptyState, FilterInput } from "@orbmeet/ui/react";
import { Page } from "@/app/shell/page";
import { collection } from "@/app/shell/collection-styles";
import { PageHeader } from "@/app/shell/page-header";
import { SpaceRow } from "@/modules/spaces/client/components/space-row";
import { CreateSpaceDialog } from "@/modules/spaces/client/components/create-space-dialog";
import { ChevronRight, Plus, Search, Users } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { SpaceTile } from "@/modules/spaces/client/components/space-tile";
import type { getMySpaces } from "@/modules/spaces/server/crud.functions";
import {
  getSpaceAccessLabel,
  getSpaceAccessLevel,
  getSpaceBillingLabel,
} from "@/modules/spaces/space-access";
import { enter } from "@orbmeet/ui/styles/animations";
import { focus, motion } from "@orbmeet/ui/styles/atoms";
import { accent, ink, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";

type ListedSpace = Awaited<ReturnType<typeof getMySpaces>>["spaces"][number];

const styles = stylex.create({
  firstSpaceIcon: { marginRight: space.s1_5 },
  emptyFiltered: { marginTop: space.s8 },
  personal: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    marginTop: space.s6,
    padding: space.s4,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n150, [env.hoverable]: { default: neutral.n150, ":hover": accent.a200 } },
    color: ink.strong,
    textDecorationLine: "none",
  },
  personalText: { display: "flex", flexDirection: "column", gap: 2, flexGrow: 1, minWidth: 0 },
  personalName: { fontSize: text.sm, fontWeight: weight.semibold },
  personalNote: { fontSize: text.xs, color: ink.muted },
  chevron: { flexShrink: 0, color: neutral.n400 },
});

/**
 * What isn't in a Space. The desktop rail lists it under the Spaces; on a
 * phone this page stands in for that list, so it is here too — not counted
 * among the Spaces, because it isn't one.
 */
function PersonalRow() {
  return (
    <Link to="/library" search={{ scope: "personal" }} {...stylex.props(styles.personal, motion.tint, focus.ring)}>
      <SpaceTile name="Personal" personal />
      <span {...stylex.props(styles.personalText)}>
        <span {...stylex.props(styles.personalName)}>Personal</span>
        <span {...stylex.props(styles.personalNote)}>Meetings and boards that aren’t in a Space</span>
      </span>
      <ChevronRight size={18} aria-hidden="true" {...stylex.props(styles.chevron)} />
    </Link>
  );
}

export function SpacesPage() {
  const { data } = useSuspenseQuery(mySpacesQueryOptions());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filteredSpaces: ListedSpace[] = data.spaces.filter((space: ListedSpace) =>
    space.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Page width="default" sx={collection.page}>
      <PageHeader
        title="Spaces"
        sx={collection.header}
        subtitle="A place for your people and the work you share."
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus size={16} /> New space
          </Button>
        }
      />

      {data.spaces.length > 0 && (
        <div {...stylex.props(collection.toolbar)}>
          <h2 {...stylex.props(collection.label)}>Your spaces<span {...stylex.props(collection.count)}>{filteredSpaces.length}{search ? ` of ${data.spaces.length}` : ""}</span></h2>
          <FilterInput label="Search Spaces" value={search} onChange={setSearch} placeholder="Find a Space…" />
        </div>
      )}

      {data.spaces.length === 0 ? (
        <EmptyState
          icon={Users}
          sx={collection.empty}
          title="Good work has a home."
          description="Create a Space for a recurring team, project group, or anyone who meets again and again."
          action={
            <Button onClick={() => setDialogOpen(true)}>
              <Plus size={16} {...stylex.props(styles.firstSpaceIcon)} />
              Create your first Space
            </Button>
          }
        />
      ) : filteredSpaces.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matching Spaces"
          description="Try a different search term."
          sx={styles.emptyFiltered}
        />
      ) : (
        <div {...stylex.props(collection.grid, enter.fadeUp)}>
          {filteredSpaces.map((space: ListedSpace) => (
            <div key={space.id}>
              <SpaceRow
                slug={space.slug}
                name={space.name}
                description={space.description}
                accessLabel={getSpaceAccessLabel(space)}
                accessLevel={getSpaceAccessLevel(space)}
                billingLabel={getSpaceBillingLabel(space.organizationName)}
              />
            </div>
          ))}
        </div>
      )}

      {search ? null : <PersonalRow />}

      <CreateSpaceDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </Page>
  );
}

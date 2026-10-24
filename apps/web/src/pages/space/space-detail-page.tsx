import { Suspense, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  spaceMembersInfiniteQueryOptions,
  spaceQueryOptions,
} from "@/app/query-client/queries/spaces";
import { spaceDefaultMeetingLinkQueryOptions } from "@/app/query-client/queries/meetings";
import { MembersList } from "@/modules/spaces/client/components/members-list";
import { SpaceHeader } from "@/modules/spaces/client/components/space-header";
import { Spinner } from "@orbmeet/ui/react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@orbmeet/ui/react";
import { getSpaceBillingLabel } from "@/modules/spaces/space-access";
import type { SpaceTab } from "@/modules/spaces/contract";
import { neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { WhiteboardsPanel } from "./whiteboards-panel";
import { MeetingsPanel } from "./meetings-panel";
import { FilesPanel } from "./files-panel";
import { SettingsPanel } from "./settings-panel";

const styles = stylex.create({
  /** A count riding beside a tab label. */
  count: {
    marginInlineStart: space.s1,
    borderRadius: radii.pill,
    backgroundColor: neutral.n100,
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    fontSize: text.xs,
    color: neutral.n600,
  },
  page: { maxWidth: 1100, marginInline: "auto", display: "flex", flexDirection: "column", gap: space.s6 },
  panelSpinner: {
    display: "flex",
    height: "10rem",
    alignItems: "center",
    justifyContent: "center",
  },
});

function CountBadge({ value }: { value: string | number }) {
  return (
    <span {...stylex.props(styles.count)}>{value}</span>
  );
}

export interface SpaceDetailPageProps {
  spaceSlug: string;
  spaceId: string;
  tab?: SpaceTab;
}

export function SpaceDetailPage({ spaceSlug, spaceId, tab }: SpaceDetailPageProps) {
  const navigate = useNavigate();

  const { data } = useSuspenseQuery(spaceQueryOptions(spaceId));
  const { data: room } = useSuspenseQuery(spaceDefaultMeetingLinkQueryOptions(spaceId));
  const {
    space,
    directRole,
    capabilities,
    viewerId,
    memberCount,
    activeMeetingCount,
    canTransferOwnership,
    canLeaveSpace,
  } = data;
  const isAdmin = capabilities.canManage;
  const canGrantAdmins = capabilities.canGrantAdmins;
  const requestedTab = tab ?? "meetings";
  const activeTab = requestedTab === "settings" && !isAdmin ? "meetings" : requestedTab;

  useEffect(() => {
    if (requestedTab === "settings" && !isAdmin) {
      void navigate({
        to: "/space/$spaceSlug",
        params: { spaceSlug },
        search: { tab: "meetings" },
        replace: true,
      });
    }
  }, [requestedTab, isAdmin, navigate, spaceSlug]);

  return (
    <div {...stylex.props(styles.page)}>
      <SpaceHeader
        spaceId={spaceId}
        spaceSlug={spaceSlug}
        name={space.name}
        description={space.description}
        memberCount={memberCount}
        roleLabel={directRole === "owner" ? "Owner" : directRole === "admin" ? "Admin" : null}
        billingLabel={getSpaceBillingLabel(space.organizationName)}
        room={{ code: room.meetingLink?.code ?? null, hasOpenMeeting: room.hasOpenMeeting }}
        canLeaveSpace={canLeaveSpace}
        onInvite={() =>
          void navigate({ to: "/space/$spaceSlug", params: { spaceSlug }, search: { tab: "people" }, replace: true })
        }
      />
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          void navigate({
            to: "/space/$spaceSlug",
            params: { spaceSlug },
            search: { tab: value as SpaceTab },
            replace: true,
          });
        }}
      >
        <TabsList scrollable>
          <TabsTrigger value="meetings">
            Timeline
            {activeMeetingCount > 0 && <CountBadge value={`${activeMeetingCount} live`} />}
          </TabsTrigger>
          <TabsTrigger value="whiteboards">Boards</TabsTrigger>
          <TabsTrigger value="people">
            People
            <CountBadge value={memberCount} />
          </TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          {isAdmin && <TabsTrigger value="settings">Settings</TabsTrigger>}
        </TabsList>

        <TabsContent value="meetings">
          <Suspense fallback={<PanelSpinner />}>
            <MeetingsPanel
              spaceId={spaceId}
              spaceSlug={spaceSlug}
              spaceName={space.name}
              timeZone={space.timeZone}
              canSchedule={isAdmin}
            />
          </Suspense>
        </TabsContent>

        <TabsContent value="whiteboards">
          <Suspense fallback={<PanelSpinner />}>
            <WhiteboardsPanel spaceId={spaceId} />
          </Suspense>
        </TabsContent>

        <TabsContent value="people">
          <Suspense fallback={<PanelSpinner />}>
            <PeoplePanel
              spaceId={spaceId}
              isAdmin={isAdmin}
              canGrantAdmins={canGrantAdmins}
              canTransferOwnership={canTransferOwnership}
              currentUserId={viewerId}
              isOrganizationSpace={Boolean(space.organizationId)}
            />
          </Suspense>
        </TabsContent>

        <TabsContent value="files">
          <Suspense fallback={<PanelSpinner />}>
            <FilesPanel
              spaceId={spaceId}
              viewerId={viewerId}
              canManageFiles={isAdmin}
            />
          </Suspense>
        </TabsContent>

        {isAdmin && (
          <TabsContent value="settings">
            <SettingsPanel
              spaceId={spaceId}
              spaceSlug={spaceSlug}
              name={space.name}
              description={space.description}
              timeZone={space.timeZone}
              organizationName={space.organizationName}
              canDelete={capabilities.canDelete}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function PeoplePanel({
  spaceId,
  isAdmin,
  canGrantAdmins,
  canTransferOwnership,
  currentUserId,
  isOrganizationSpace,
}: {
  spaceId: string;
  isAdmin: boolean;
  canGrantAdmins: boolean;
  canTransferOwnership: boolean;
  currentUserId: string;
  isOrganizationSpace: boolean;
}) {
  const membersQuery = useSuspenseInfiniteQuery(
    spaceMembersInfiniteQueryOptions(spaceId),
  );
  const members = membersQuery.data.pages.flatMap((page) => page.members);

  return (
    <MembersList
      spaceId={spaceId}
      members={members}
      isAdmin={isAdmin}
      canGrantAdmins={canGrantAdmins}
      canTransferOwnership={canTransferOwnership}
      currentUserId={currentUserId}
      isOrganizationSpace={isOrganizationSpace}
      hasMore={membersQuery.hasNextPage}
      isLoadingMore={membersQuery.isFetchingNextPage}
      onLoadMore={() => {
        void membersQuery.fetchNextPage();
      }}
    />
  );
}

function PanelSpinner() {
  return (
    <div {...stylex.props(styles.panelSpinner)}>
      <Spinner size="md" brand />
    </div>
  );
}

import { useState } from "react";
import { describeWhiteboardActivity } from "@/modules/whiteboards/client/whiteboard-activity";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { spaceWhiteboardsQueryOptions } from "@/app/query-client/queries/spaces";
import { NewWhiteboardDialog } from "@/modules/whiteboards/client/components/new-whiteboard-dialog";
import { List, ListGlyph, ListRow } from "@/app/shell/list";
import { Section } from "@/app/shell/section";
import { Button, EmptyState } from "@orbmeet/ui/react";
import { stack } from "@orbmeet/ui/styles/atoms";
import { PenTool, Plus } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { panelStyles } from "./space-panel-styles";


export function WhiteboardsPanel({ spaceId }: { spaceId: string }) {
  const query = useSuspenseInfiniteQuery(spaceWhiteboardsQueryOptions(spaceId));
  const whiteboards = query.data.pages.flatMap((page) => page.whiteboards);
  const [creating, setCreating] = useState(false);

  return (
    <Section
      title="Whiteboards"
      description="Shared Whiteboards that stay with this Space across Meetings."
      action={
        <Button type="button" variant="secondary" size="sm" onClick={() => setCreating(true)}>
          <Plus size={14} />
          New Whiteboard
        </Button>
      }
    >
      {whiteboards.length === 0 ? (
        <EmptyState
          icon={PenTool}
          title="No Whiteboards yet"
          description="Create a Whiteboard for the Space to prepare, meet, and continue working in."
        />
      ) : (
        <div {...stylex.props(stack.x3)}>
          <List label="Space whiteboards">
            {whiteboards.map((whiteboard) => (
              <ListRow
                key={whiteboard.id}
                leading={<ListGlyph><PenTool size={16} /></ListGlyph>}
                title={whiteboard.title}
                link={{ to: "/whiteboards/$whiteboardId", params: { whiteboardId: whiteboard.id } }}
                meta={<span>{describeWhiteboardActivity(whiteboard)}</span>}
              />
            ))}
          </List>
          {query.hasNextPage ? (
            <div {...stylex.props(panelStyles.pagerFoot)}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => { void query.fetchNextPage(); }}
                loading={query.isFetchingNextPage}
              >
                Load more Whiteboards
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <NewWhiteboardDialog open={creating} onOpenChange={setCreating} spaceId={spaceId} />
    </Section>
  );
}

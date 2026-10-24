import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Settings2 } from "lucide-react";
import * as stylex from "@stylexjs/stylex";

import { myThreadsQueryOptions } from "@/app/query-client/queries/meetings";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { RoomLinkSettings } from "@/modules/meetings/client/components/links/room-link-settings";
import { CreatePersonalMeetingLinkDialog } from "@/modules/meetings/client/dashboard/create-personal-meeting-link-dialog";
import { Button } from "@orbmeet/ui/react";
import { ink } from "@orbmeet/ui/tokens/colors.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts } from "@orbmeet/ui/tokens/typography.stylex";
import { settings } from "../settings-styles";
import { SettingsSection } from "./settings-section";

const styles = stylex.create({
  code: { fontFamily: fonts.mono, color: ink.strong },
  // Two buttons beside the text squeeze it to a word a line on a phone, so the
  // text keeps a readable width and the buttons drop under it when they must.
  row: { flexWrap: "wrap" },
  body: { flexGrow: 1, flexShrink: 1, flexBasis: "14rem", minWidth: 0 },
  actions: { display: "flex", flexWrap: "wrap", gap: space.s2, flexShrink: 0 },
});

/**
 * Your room: the one link people can always use to reach you. What a
 * meeting in it is called and who may walk straight in live behind
 * "Room settings".
 */
export function MeetingsSection() {
  const { data } = useQuery(myThreadsQueryOptions());
  const room = data?.threads.find((thread) => thread.kind === "personal");
  const { copied, copy } = useCopyToClipboard();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  return (
    <SettingsSection title="Meetings">
      <div {...stylex.props(settings.itemRow, styles.row)}>
        <div {...stylex.props(styles.body)}>
          <p {...stylex.props(settings.itemName)}>Your room link</p>
          <p {...stylex.props(settings.itemMeta, settings.itemMetaSpaced)}>
            {room ? (
              <>
                <span {...stylex.props(styles.code)}>{room.code}</span> · Anyone with it can knock, and you let them in.
              </>
            ) : (
              "One link people can always use to reach you."
            )}
          </p>
        </div>
        {room ? (
          <div {...stylex.props(styles.actions)}>
            <Button variant="secondary" size="sm" onClick={() => void copy(`${window.location.origin}/${room.code}`)}>
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={14} aria-hidden="true" /> Room settings
            </Button>
          </div>
        ) : data ? (
          <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
            Make a room link
          </Button>
        ) : null}
      </div>
      {room ? <RoomLinkSettings thread={room} open={settingsOpen} onOpenChange={setSettingsOpen} /> : null}
      <CreatePersonalMeetingLinkDialog open={creating} onOpenChange={setCreating} />
    </SettingsSection>
  );
}

import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { Switch } from "@orbmeet/ui/react";
import * as stylex from "@stylexjs/stylex";

import { queryKeys } from "@/app/query-client/query-keys";
import { useSpaceTranscriptionDefault } from "@/modules/spaces/client/use-space-transcription";
import { getPersonalSpaceTranscription } from "@/modules/spaces/server/transcription.functions";
import { settings } from "../settings-styles";
import { SettingsSection } from "./settings-section";

/**
 * What Orb does in this person's own meetings, the ones on their personal
 * link. Today that is one thing: whether they begin with transcription on.
 * A shared Space's meetings follow that Space's own setting instead. In the
 * meeting, a host or co-host can still turn it on or off for everyone.
 */
export function OrbSection() {
  const labelId = useId();
  const noteId = useId();
  const { data } = useQuery({
    queryKey: queryKeys.spaces.personalTranscription(),
    queryFn: () => getPersonalSpaceTranscription(),
  });
  const transcription = useSpaceTranscriptionDefault(data);

  return (
    <SettingsSection title="Orb">
      <div {...stylex.props(settings.itemRow)}>
        <div>
          <p id={labelId} {...stylex.props(settings.itemName)}>Transcribe my meetings</p>
          <p id={noteId} {...stylex.props(settings.itemMeta, settings.itemMetaSpaced)}>
            {transcription && !transcription.on
              ? "Meetings on your own link begin with transcription off: nothing anyone says is sent to Deepgram, so there are no captions, transcript or summary."
              : "Meetings on your own link begin with transcription on: what people say is sent to Deepgram for live captions, the transcript and the summary."}{" "}
            A Space&rsquo;s meetings follow that Space&rsquo;s setting. A host or co-host can change it during a meeting.
          </p>
        </div>
        <Switch
          checked={transcription?.on ?? true}
          pending={!transcription || transcription.pending}
          onCheckedChange={(next) => void transcription?.set(next)}
          aria-labelledby={labelId}
          aria-describedby={noteId}
        />
      </div>
      {transcription?.failed && (
        <p role="alert" {...stylex.props(settings.itemMeta, settings.itemMetaSpaced)}>
          That change didn&rsquo;t save. Try again.
        </p>
      )}
    </SettingsSection>
  );
}

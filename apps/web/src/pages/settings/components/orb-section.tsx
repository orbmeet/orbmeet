import { useId } from "react";
import { Switch } from "@orbmeet/ui/react";
import * as stylex from "@stylexjs/stylex";

import { useTranscribeMeetingsPreference } from "@/modules/identity/client/use-transcribe-meetings-preference";
import { settings } from "../settings-styles";
import { SettingsSection } from "./settings-section";

/**
 * What Orb does in the meetings this user starts. Today that is
 * one thing: whether they begin with transcription on. In the meeting, a host
 * or co-host can still turn it on or off for everyone, and the starter can
 * change this default from there too.
 */
export function OrbSection({ user }: { user: { transcribeMeetings: boolean } }) {
  const labelId = useId();
  const noteId = useId();
  const preference = useTranscribeMeetingsPreference();

  const on = preference?.on ?? user.transcribeMeetings;

  return (
    <SettingsSection title="Orb">
      <div {...stylex.props(settings.itemRow)}>
        <div>
          <p id={labelId} {...stylex.props(settings.itemName)}>Transcribe meetings I start</p>
          <p id={noteId} {...stylex.props(settings.itemMeta, settings.itemMetaSpaced)}>
            {on
              ? "Your meetings begin with transcription on: what people say is sent to Deepgram for live captions, the transcript and the summary."
              : "Your meetings begin with transcription off: nothing anyone says is sent to Deepgram, so there are no captions, transcript or summary."}{" "}
            A host or co-host can change it during a meeting, and you can change this default from there too.
          </p>
        </div>
        <Switch
          checked={on}
          pending={preference?.pending ?? false}
          onCheckedChange={(next) => void preference?.set(next)}
          aria-labelledby={labelId}
          aria-describedby={noteId}
        />
      </div>
      {preference?.failed && (
        <p role="alert" {...stylex.props(settings.itemMeta, settings.itemMetaSpaced)}>
          That change didn&rsquo;t save. Try again.
        </p>
      )}
    </SettingsSection>
  );
}

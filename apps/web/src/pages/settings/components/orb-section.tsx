import { useId } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@orbmeet/ui/react";
import * as stylex from "@stylexjs/stylex";

import { queryKeys } from "@/app/query-client/query-keys";
import { setTranscribeMeetings } from "@/modules/identity/server/account.functions";
import { settings } from "../settings-styles";
import { SettingsSection } from "./settings-section";

/**
 * What Orb does in the meetings this user starts. Today that is
 * one thing: whether they begin with transcription on. In the meeting, a host
 * or co-host can still turn it on or off for everyone.
 */
export function OrbSection({ user }: { user: { transcribeMeetings: boolean } }) {
  const queryClient = useQueryClient();
  const labelId = useId();
  const noteId = useId();

  const mutation = useMutation({
    mutationFn: (on: boolean) => setTranscribeMeetings({ data: { on } }),
    onMutate: async (on) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.session() });
      const previousSession = queryClient.getQueryData(queryKeys.session());
      queryClient.setQueryData(queryKeys.session(), (old) => {
        if (!old || typeof old !== "object") return old;
        const session = old as Record<string, unknown>;
        if (!session.user || typeof session.user !== "object") return old;
        return { ...session, user: { ...(session.user as Record<string, unknown>), transcribeMeetings: on } };
      });
      return { previousSession };
    },
    onError: (_error, _on, context) => {
      if (context?.previousSession !== undefined) {
        queryClient.setQueryData(queryKeys.session(), context.previousSession);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.session() });
    },
  });

  const on = user.transcribeMeetings;

  return (
    <SettingsSection title="Orb">
      <div {...stylex.props(settings.itemRow)}>
        <div>
          <p id={labelId} {...stylex.props(settings.itemName)}>Transcribe meetings I start</p>
          <p id={noteId} {...stylex.props(settings.itemMeta, settings.itemMetaSpaced)}>
            {on
              ? "Your meetings begin with transcription on: what people say is sent to Deepgram for live captions, the transcript and the summary."
              : "Your meetings begin with transcription off: nothing anyone says is sent to Deepgram, so there are no captions, transcript or summary."}{" "}
            A host or co-host can change it during the meeting.
          </p>
        </div>
        <Switch
          checked={on}
          pending={mutation.isPending}
          onCheckedChange={(next) => mutation.mutate(next)}
          aria-labelledby={labelId}
          aria-describedby={noteId}
        />
      </div>
      {mutation.isError && (
        <p role="alert" {...stylex.props(settings.itemMeta, settings.itemMetaSpaced)}>
          That change didn&rsquo;t save. Try again.
        </p>
      )}
    </SettingsSection>
  );
}

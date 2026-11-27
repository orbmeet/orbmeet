import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import { setSpaceTranscription } from "@/modules/spaces/server/transcription.functions";

export interface SpaceTranscriptionDefault {
  /** Whether the Space's meetings begin with transcription on. */
  on: boolean;
  pending: boolean;
  /** The last change did not save. */
  failed: boolean;
  set: (on: boolean) => Promise<void>;
}

/**
 * A Space's transcription default, for someone who may change it: the Space's
 * settings, the account's Settings for the personal Space, and a host's switch
 * in the meeting all read and write it here. Null when there is none to show.
 */
export function useSpaceTranscriptionDefault(
  space: { spaceId: string; on: boolean } | null | undefined,
): SpaceTranscriptionDefault | null {
  const queryClient = useQueryClient();
  // What this viewer last saved, until the value it was given changes.
  const [saved, setSaved] = useState<boolean | null>(null);
  const [given, setGiven] = useState(space?.on);
  if (space?.on !== given) {
    setGiven(space?.on);
    setSaved(null);
  }

  const mutation = useMutation({
    mutationFn: (on: boolean) => setSpaceTranscription({ data: { spaceId: space!.spaceId, on } }),
    onSuccess: (result) => setSaved(result.on),
    onSettled: async () => {
      if (!space) return;
      // The slug payload seeds the detail entry when the Space's page opens,
      // and is not keyed by id: every one goes, or the page would reopen on
      // the old default.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.detail(space.spaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.slugs() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.spaces.personalTranscription() }),
      ]);
    },
  });

  if (!space) return null;
  return {
    on: mutation.isPending ? mutation.variables : saved ?? space.on,
    pending: mutation.isPending,
    failed: mutation.isError,
    set: async (on) => {
      await mutation.mutateAsync(on).catch(() => undefined);
    },
  };
}

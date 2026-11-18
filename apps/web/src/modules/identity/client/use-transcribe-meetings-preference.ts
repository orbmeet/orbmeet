import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/app/query-client/query-keys";
import { sessionQueryOptions } from "@/app/query-client/queries/session";
import { setTranscribeMeetings } from "@/modules/identity/server/account.functions";

export interface TranscribeMeetingsPreference {
  /** Whether the meetings this user starts begin with transcription on. */
  on: boolean;
  pending: boolean;
  /** The last change did not save. */
  failed: boolean;
  set: (on: boolean) => Promise<void>;
}

/**
 * The signed-in user's "Transcribe meetings I start" default, read from and
 * written to the session, for Settings and for the meeting's own switch alike.
 * Null for a guest, who has no account to keep a default on.
 */
export function useTranscribeMeetingsPreference(): TranscribeMeetingsPreference | null {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQueryOptions());

  const mutation = useMutation({
    mutationFn: (on: boolean) => setTranscribeMeetings({ data: { on } }),
    onMutate: async (on) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.session() });
      const previousSession = queryClient.getQueryData(queryKeys.session());
      queryClient.setQueryData(queryKeys.session(), (old) => {
        if (!old || typeof old !== "object") return old;
        const current = old as Record<string, unknown>;
        if (!current.user || typeof current.user !== "object") return old;
        return { ...current, user: { ...(current.user as Record<string, unknown>), transcribeMeetings: on } };
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

  const user = session?.user;
  if (!user) return null;
  return {
    on: user.transcribeMeetings,
    pending: mutation.isPending,
    failed: mutation.isError,
    set: async (on) => {
      await mutation.mutateAsync(on).catch(() => undefined);
    },
  };
}

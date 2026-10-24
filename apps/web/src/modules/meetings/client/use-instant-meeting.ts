import { useMutation } from "@tanstack/react-query";
import { createMeetingLink } from "@/modules/meetings/server/lifecycle/create.functions";
import { beginMeetingEntryFlow } from "@/modules/meetings/client/entry-metrics";

/**
 * Creates a one-time meeting and enters it immediately — the same direct-entry
 * flow the landing page uses. Recording stays available per plan (whether it
 * runs is the host's in-room choice) and join approval can be toggled from
 * inside the room, so nothing needs to be asked at creation time.
 */
export function useInstantMeeting(options: { onError: (error: unknown) => void }) {
  return useMutation({
    mutationFn: () =>
      createMeetingLink({
        data: {
          allowGuests: true,
        },
      }),
    onMutate: () => {
      beginMeetingEntryFlow({ source: "dashboard-create" });
    },
    onSuccess: (result) => {
      // Full page reload required: the server must set meet-route CSP
      // (connect-src includes livekit, Permissions-Policy grants camera/mic).
      window.location.href = `/${result.code}`;
    },
    onError: options.onError,
  });
}

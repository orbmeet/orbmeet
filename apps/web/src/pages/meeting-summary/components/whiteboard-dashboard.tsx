import * as React from "react";
import type { getEndedMeeting } from "@/modules/transcripts/server/meeting-summary.functions";

type EndedMeeting = NonNullable<
  Awaited<ReturnType<typeof getEndedMeeting>>["meeting"]
>;

const LazyMeetingWhiteboardPanel = React.lazy(async () => {
  const module = await import("@/pages/meeting-summary/components/whiteboard-pdf-panel");
  return { default: module.MeetingWhiteboardPanel };
});

export function MeetingWhiteboardPanel(props: {
  meeting: EndedMeeting;
  onGenerated?: () => void;
}) {
  return (
    <React.Suspense fallback={null}>
      <LazyMeetingWhiteboardPanel {...props} />
    </React.Suspense>
  );
}

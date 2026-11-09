import { Button } from "@orbmeet/ui/react";
import { Download } from "lucide-react";
import { getMeetingArtifactDownloadUrl } from "@/modules/meetings/server/history/output-downloads.functions";

/** Kept apart from the player: the page shows this without loading Vidstack. */
export function downloadRecording(artifactId: string) {
  void getMeetingArtifactDownloadUrl({ data: { artifactId } }).then((res) => {
    // The URL is served as an attachment, so navigating to it downloads
    // without leaving the page. A popup opened after this await has lost
    // the click's user activation and is silently blocked.
    window.location.assign(res.url);
  });
}

/** The "Download" action that sits in the Recording section's header. */
export function RecordingDownloadButton({ artifactId, filename }: { artifactId: string; filename?: string | null }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      title={filename ?? "Download recording"}
      onClick={() => downloadRecording(artifactId)}
    >
      <Download size={14} />
      Download
    </Button>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { handleInternalTranscriptRequest } from "./-transcripts.server";

export const Route = createFileRoute("/api/internal/transcripts")({
  server: {
    handlers: {
      POST: ({ request }) => handleInternalTranscriptRequest(request),
    },
  },
});

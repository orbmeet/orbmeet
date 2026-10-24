import { parseInput } from "@/lib/validation";
import { createFileRoute } from "@tanstack/react-router";
import { automationMeetingLookupSchema } from "@orbmeet/public-api-contract";
import { Errors } from "@/lib/app-errors";

import { apiJson, handleAutomationApi } from "@/app/adapters/public-api/http";
import { retrieveAutomationMeeting } from "@/app/adapters/public-api/meeting-retrieval";

function readIncludes(url: URL): string[] {
  return url.searchParams.getAll("include")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export const Route = createFileRoute("/api/v1/meetings/")({
  server: {
    handlers: {
      GET: ({ request }) =>
        handleAutomationApi(request, "meetings:read", async ({ env, principal }) => {
          const url = new URL(request.url);
          const cursorStartedAt = url.searchParams.get("cursorStartedAt");
          const cursorId = url.searchParams.get("cursorId");
          if ((cursorStartedAt === null) !== (cursorId === null)) {
            throw Errors.VALIDATION("cursorStartedAt and cursorId must be provided together");
          }
          // An empty cursor is a malformed one, not a request for the first page:
          // serving page one again would loop an export forever.
          if (cursorStartedAt === "" || cursorId === "") {
            throw Errors.VALIDATION("cursorStartedAt and cursorId must not be empty");
          }
          const parsed = parseInput(automationMeetingLookupSchema, {
            meetingId: url.searchParams.get("meetingId") || undefined,
            date: url.searchParams.get("date") || undefined,
            timeZone: url.searchParams.get("timezone") || undefined,
            title: url.searchParams.get("title") || undefined,
            space: url.searchParams.get("space") || undefined,
            participant: url.searchParams.get("participant") || undefined,
            include: readIncludes(url),
            transcriptCursor: cursorStartedAt && cursorId
              ? { startedAt: Number(cursorStartedAt), id: cursorId }
              : undefined,
            transcriptLimit: url.searchParams.has("transcriptLimit")
              ? Number(url.searchParams.get("transcriptLimit"))
              : undefined,
          });
          return apiJson({
            data: await retrieveAutomationMeeting(
              principal.db,
              env,
              principal.user.id,
              parsed,
            ),
          });
        }),
    },
  },
});

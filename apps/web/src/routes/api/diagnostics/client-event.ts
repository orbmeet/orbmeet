import { createFileRoute } from "@tanstack/react-router";
import { logInfo, logWarn } from "@/lib/logger";
import {
  parseClientDiagnostic,
  PROBLEM_DIAGNOSTIC_EVENTS,
} from "@/modules/meetings/client/entry/diagnostic-contract";
import { readBrowserReport, reportOrigin } from "./-report.server";

// The wire contract lives in `diagnostic-contract.ts` so the emitter and this
// endpoint cannot drift apart again. They had: the client shipped the capture
// classification `issue.md` asked for and this endpoint silently stripped every
// field of it. Detail fields are now accepted and bounded rather than dropped.

export const Route = createFileRoute("/api/diagnostics/client-event")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const read = await readBrowserReport(request, "diagnostics");
        if (read instanceof Response) return read;

        const parsed = parseClientDiagnostic(read.body);
        if (!parsed) return new Response("Invalid request", { status: 400 });

        const { detail, ...envelope } = parsed;
        const log = PROBLEM_DIAGNOSTIC_EVENTS.has(envelope.event) ? logWarn : logInfo;
        log("[client-diagnostic]", { ...envelope, ...detail, ...reportOrigin(request) });
        return new Response("OK", { status: 200 });
      },
    },
  },
});

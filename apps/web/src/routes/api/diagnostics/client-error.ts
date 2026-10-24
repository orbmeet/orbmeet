import { createFileRoute } from "@tanstack/react-router";
import { logError } from "@/lib/logger";
import { parseClientErrorReport } from "@/lib/telemetry/client-error-contract";
import { readBrowserReport, reportOrigin } from "./-report.server";

/** An error a page met: escaped to its window, or caught by an error boundary. */
export const Route = createFileRoute("/api/diagnostics/client-error")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const read = await readBrowserReport(request, "client-errors");
        if (read instanceof Response) return read;

        const report = parseClientErrorReport(read.body);
        if (!report) return new Response("Invalid request", { status: 400 });

        logError("[client-error]", { ...report, ...reportOrigin(request) });
        return new Response("OK", { status: 200 });
      },
    },
  },
});

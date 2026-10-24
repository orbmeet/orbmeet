import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Route-drift guard for the whiteboard client package.
 *
 * Sync-server wire paths must come from `WHITEBOARD_SYNC_ROUTES`
 * (`@orbmeet/whiteboard-core/protocol`) and host-application endpoints must
 * come from the `WhiteboardServiceEndpoints` adapter supplied by the
 * integration layer. This scan fails if anyone re-embeds a route literal in
 * package source, so route coupling cannot quietly creep back in — the failure
 * mode that produced hardcoded `/broadcast`, `/api/ai/*`, and `/pdf-render`
 * strings scattered across components.
 */

// The only module allowed to mention route literals is the boundary adapter
// itself; tests and generated asset URL maps are also exempt.
const EXEMPT_FILES = new Set(["service-endpoints.ts"]);
const EXEMPT_PATTERNS = [/\.test\.(ts|tsx)$/, /^generated\//];

const FORBIDDEN_ROUTE_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "host API route", pattern: /(["'`])\/api\// },
  {
    label: "sync route",
    pattern: /(["'`])\/(connect|broadcast|ai-chat-history|unfurl|pdf-import)\1/,
  },
];

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) return [];
    return [path];
  });
}

describe("whiteboard-client route drift", () => {
  const srcDir = import.meta.dirname;

  it("embeds no hardcoded service routes outside the endpoint adapter", () => {
    const violations: string[] = [];

    for (const path of listSourceFiles(srcDir)) {
      const relative = path.slice(srcDir.length + 1).replaceAll("\\", "/");
      if ([...EXEMPT_FILES].some((name) => relative === `lib/${name}`)) continue;
      if (EXEMPT_PATTERNS.some((pattern) => pattern.test(relative))) continue;

      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const { label, pattern } of FORBIDDEN_ROUTE_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(`${relative}:${index + 1} ${label}: ${line.trim()}`);
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });
});

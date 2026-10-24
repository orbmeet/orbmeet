import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Meeting connection state boundary.
 *
 * What a connection's status means — present, seated, awaiting, unfinished,
 * ended — and what writing a transition sets, are defined once in
 * `modules/meetings/server/connection/`. Server code elsewhere asks through
 * those names instead of comparing `connection_status` to a literal. Two
 * spellings of "active" that differed by one status are how an authorization
 * gate and the write fence behind it came to disagree about the same actor.
 */

const webRoot = fileURLToPath(new URL("../../../", import.meta.url));
const srcRoot = resolve(webRoot, "src");
const CONNECTION_MODULE = "modules/meetings/server/connection/";

const SERVER_OWNED_DIR = /(^|\/)server\//;
const SERVER_OWNED_SUFFIX = /\.server\.tsx?$/;

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /connectionStatus\s*[!=]==\s*["']/, what: "status compared to a literal" },
  { pattern: /connectionStatus\s*,\s*["'[]/, what: "status matched against a literal in a query" },
  { pattern: /connection_?[sS]tatus\}?\s*(?:!?=|<>|\bin\b|\bnot in\b)\s*\(?\s*'/, what: "status matched against a literal in SQL" },
  { pattern: /connectionStatus:\s*["'](?:pending|live|ended)["']/, what: "status written directly instead of through a transition" },
];

function collectServerOwned(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return collectServerOwned(fullPath);
    if (!entry.isFile() || !/\.(tsx?|mts)$/.test(entry.name)) return [];
    if (/\.test\.[mt]sx?$/.test(entry.name)) return [];
    const rel = relative(srcRoot, fullPath);
    if (!(SERVER_OWNED_DIR.test(rel) || SERVER_OWNED_SUFFIX.test(rel))) return [];
    if (rel.startsWith(CONNECTION_MODULE)) return [];
    return [fullPath];
  });
}

/** Comments may describe the rule; only code is held to it. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("meeting connection state boundary", () => {
  it("keeps connection status literals inside the connection module", () => {
    const violations: string[] = [];

    for (const path of collectServerOwned(srcRoot)) {
      const rel = relative(srcRoot, path);
      const lines = stripComments(readFileSync(path, "utf8")).split("\n");
      lines.forEach((line, index) => {
        for (const { pattern, what } of FORBIDDEN) {
          if (pattern.test(line)) violations.push(`${rel}:${index + 1} ${what}: ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});

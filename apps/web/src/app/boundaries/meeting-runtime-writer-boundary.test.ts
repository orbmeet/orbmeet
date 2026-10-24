import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Meeting runtime single-writer boundary.
 *
 * While a meeting runs, its MeetingRoom Durable Object is the only writer of
 * its live state and of the rows that project it (`meeting_admissions`,
 * `meeting_connections`). The room writes only the rows that differ from its
 * previous state, so a second writer's rows would never be corrected: they
 * could be overwritten, or overwrite the room's.
 *
 * Reads are free. The one other writer is the purge of a Space's history,
 * which only runs on meetings that have drained, when no room holds them.
 */

const srcRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)), "src");

const OWNED_TABLES = ["meetingAdmissions", "meetingConnections"];
const OWNED_SQL_TABLES = ["meeting_admissions", "meeting_connections"];

const ALLOWED: Record<string, string> = {
  "modules/meetings/server/runtime/projection.server.ts": "the meeting room's projection",
  "workflows/space-deletion/cleanup.server.ts": "purges admissions of drained meetings",
};

const DRIZZLE_WRITE = new RegExp(`\\.(?:insert|update|delete)\\(\\s*(?:${OWNED_TABLES.join("|")})\\s*\\)`);
const SQL_WRITE = new RegExp(`(?:insert\\s+into|update|delete\\s+from)\\s+[\`"]?(?:${OWNED_SQL_TABLES.join("|")})\\b`, "i");
const TABLE_NAME = new RegExp(`["'\`](?:${OWNED_SQL_TABLES.join("|")})["'\`]`);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    if (!/\.(tsx?|mts)$/.test(entry.name) || /\.test\.[mt]sx?$/.test(entry.name)) return [];
    return [fullPath];
  });
}

/**
 * The columns of `meetings` the room projects from its state: once the room
 * holds a meeting, a write from anywhere else would be overwritten by its
 * next projection, or overwrite it. Creating the row sets them first, before
 * any room exists.
 */
const OWNED_MEETING_COLUMNS = [
  "joinPolicy", "mediaNodeId", "firstJoinedAt", "activeEgressId", "activeStreamEgressId", "egressStateRevision",
];
const OWNED_MEETING_SQL_COLUMNS = [
  "join_policy", "media_node_id", "first_joined_at", "active_egress_id", "active_stream_egress_id", "egress_state_revision",
];
const MEETING_UPDATE = /\.update\(\s*meetings\s*\)\s*\.set\(\{([\s\S]*?)\}\)/g;

const MEETING_COLUMN_WRITERS: Record<string, string> = {
  "modules/meetings/server/runtime/projection.server.ts": "the meeting room's projection",
  "modules/meetings/server/lifecycle/finalize.ts": "the room's meeting.finalize effect, clearing egress as the meeting ends",
};

/** Comments may describe the rule; only code is held to it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("meeting runtime single-writer boundary", () => {
  it("keeps writes to a live meeting's projection inside its room", () => {
    const violations: string[] = [];
    for (const path of sourceFiles(srcRoot)) {
      const rel = relative(srcRoot, path);
      if (ALLOWED[rel] || rel.endsWith(".gen.ts")) continue;
      const code = stripComments(readFileSync(path, "utf8"));
      if (DRIZZLE_WRITE.test(code) || SQL_WRITE.test(code) || TABLE_NAME.test(code)) violations.push(rel);
    }
    expect(violations).toEqual([]);
  });

  it("keeps writes to the live columns of a meeting's row inside its room", () => {
    const violations: string[] = [];
    for (const path of sourceFiles(srcRoot)) {
      const rel = relative(srcRoot, path);
      if (MEETING_COLUMN_WRITERS[rel] || rel.endsWith(".gen.ts")) continue;
      const code = stripComments(readFileSync(path, "utf8"));
      for (const [, assignments] of code.matchAll(MEETING_UPDATE)) {
        const written = OWNED_MEETING_COLUMNS.filter((column) => new RegExp(`\\b${column}\\s*:`).test(assignments));
        if (written.length > 0) violations.push(`${rel}: ${written.join(", ")}`);
      }
      const written = OWNED_MEETING_SQL_COLUMNS.filter((column) =>
        new RegExp(`update\\s+[\`"]?meetings[\`"]?\\s+set[\\s\\S]*?\\b${column}\\b`, "i").test(code));
      if (written.length > 0) violations.push(`${rel}: ${written.join(", ")}`);
    }
    expect(violations).toEqual([]);
  });
});

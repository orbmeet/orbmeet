import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The schema's doc comments are the written model of the product, and they
// drifted once: tables moved between files and their comments stayed behind,
// so `meeting_admissions` was described as an address book. Every table must
// carry its own comment directly above it, and no top-level doc comment may be
// left describing nothing.
const schemaDir = fileURLToPath(new URL("../../../../../packages/db/src/schema/", import.meta.url));

const TABLE = /^export const (\w+) = sqliteTable\(/;
const BANNER = /^\/\/ =+$/;
const DECLARATION = /^export (?:const|function|async function|type|interface) /;
const INFERRED_TYPE = /\$infer(?:Select|Insert)/;

function schemaFiles(): Array<{ file: string; lines: string[] }> {
  return readdirSync(schemaDir)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .map((name) => ({ file: name, lines: readFileSync(join(schemaDir, name), "utf8").split("\n") }));
}

function previousNonBlank(lines: string[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") return lines[i];
  }
  return undefined;
}

function nextNonBlank(lines: string[], index: number): string | undefined {
  for (let i = index + 1; i < lines.length; i++) {
    if (lines[i].trim() !== "") return lines[i];
  }
  return undefined;
}

describe("schema doc comments", () => {
  it("puts a comment directly above every table", () => {
    const missing: string[] = [];
    for (const { file, lines } of schemaFiles()) {
      lines.forEach((line, index) => {
        const table = TABLE.exec(line);
        if (!table) return;
        const above = previousNonBlank(lines, index)?.trim() ?? "";
        const commented = above.endsWith("*/") || (above.startsWith("//") && !BANNER.test(above));
        if (!commented) missing.push(`${file}: ${table[1]}`);
      });
    }
    expect(missing).toEqual([]);
  });

  it("leaves no top-level doc comment describing nothing", () => {
    const orphaned: string[] = [];
    for (const { file, lines } of schemaFiles()) {
      lines.forEach((line, index) => {
        if (line !== " */") return;
        const next = nextNonBlank(lines, index) ?? "";
        if (!DECLARATION.test(next) || INFERRED_TYPE.test(next)) {
          orphaned.push(`${file}:${index + 1} is followed by ${JSON.stringify(next.slice(0, 60))}`);
        }
      });
    }
    expect(orphaned).toEqual([]);
  });
});

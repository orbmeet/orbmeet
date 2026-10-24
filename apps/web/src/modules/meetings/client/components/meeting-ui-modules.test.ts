import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getRuntimeDynamicImports } from "../../../../../build/source-analysis/static-imports";

const clientRoot = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [fullPath] : [];
  });
}

describe("meeting UI modules", () => {
  // A part of the meeting loaded on its own, but not from meeting-ui-modules.ts,
  // is not preloaded at the door: after a deploy it may fail to load mid-call.
  it("loads every part of the meeting UI that loads on its own from one list", () => {
    const elsewhere = sourceFiles(clientRoot).flatMap((path) =>
      relative(clientRoot, path) === "components/meeting-ui-modules.ts"
        ? []
        : getRuntimeDynamicImports(path)
          .filter((specifier) => specifier.startsWith(".") || specifier.startsWith("@/"))
          .map((specifier) => `${relative(clientRoot, path)} -> ${specifier}`));

    expect(elsewhere).toEqual([]);
  });
});

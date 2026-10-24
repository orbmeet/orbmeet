import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `@orbmeet/domain-model` owns the product's value sets. The D1 CHECK
// constraints, the web contracts, and the public API schemas import them from
// there, and this test stops a private copy from creeping back in: a duplicate
// list compiles fine and only shows up later as a value one layer accepts and
// another rejects.
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const domainModel = join(repoRoot, "packages/domain-model/src/index.ts");

const scannedRoots = [
  "apps/web/src",
  "apps/whiteboard-server/src",
  "apps/transcription-agent/src",
  "apps/cli/src",
  "packages/db/src",
  "packages/public-api-contract/src",
  "packages/ui/src",
  "packages/whiteboard-core/src",
  "packages/whiteboard-client/src",
];

const MINIMUM_TRACKED_SIZE = 2;

// Paddle's own status vocabulary currently matches ours value for value. It is
// an external contract we translate from, not a copy of ours, so it stays
// spelled out where the translation happens.
const EXEMPT_FILES = new Set(["apps/web/src/modules/billing/server/paddle-subscription.ts"]);

function stringArrayLiterals(source: string): string[][] {
  return [...source.matchAll(/\[((?:\s*"[^"\n]*"\s*,?)+)\s*\]/g)].map((match) =>
    [...match[1].matchAll(/"([^"\n]*)"/g)].map((value) => value[1]),
  );
}

function key(values: readonly string[]): string {
  return [...values].sort().join("\u0000");
}

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "dist"
        ? []
        : collectSourceFiles(fullPath);
    }
    if (!entry.isFile() || !/\.(tsx?|mts)$/.test(entry.name)) return [];
    // Tests spell out the values they assert on; that is the point of them.
    return entry.name.includes(".test.") ? [] : [fullPath];
  });
}

const ownedValueSets = new Map<string, string[]>();
for (const match of readFileSync(domainModel, "utf8").matchAll(
  /export const (\w+) = (\[[\s\S]*?\]) as const;/g,
)) {
  const values = [...match[2].matchAll(/"([^"\n]*)"/g)].map((value) => value[1]);
  if (values.length < MINIMUM_TRACKED_SIZE) continue;
  const valueKey = key(values);
  ownedValueSets.set(valueKey, [...(ownedValueSets.get(valueKey) ?? []), match[1]]);
}

describe("domain value ownership", () => {
  it("tracks the domain model's own value sets", () => {
    expect(ownedValueSets.size).toBeGreaterThan(10);
  });

  it("finds no re-declared copy of a domain value set", () => {
    const duplicates = scannedRoots.flatMap((root) =>
      collectSourceFiles(join(repoRoot, root))
        .filter((path) => !EXEMPT_FILES.has(relative(repoRoot, path)))
        .flatMap((path) =>
          stringArrayLiterals(readFileSync(path, "utf8"))
            .map((values) => ownedValueSets.get(key(values)))
            .filter((owners) => owners !== undefined)
            .map((owners) => `${relative(repoRoot, path)} re-declares ${owners.join(" / ")}`),
        ),
    );

    expect([...new Set(duplicates)]).toEqual([]);
  });
});

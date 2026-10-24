import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFile } from "../../../build/source-analysis/parse-source";

/**
 * Server→client ownership boundary.
 *
 * Server-owned modules (`*.server.*` files and `modules/<m>/server/**`) must
 * not import anything from a client ownership tree (`modules/<m>/client/**`) —
 * runtime *or* type-only. Code that both sides need lives in the module's
 * `contract/` layer (or another neutral location); server-only SDK, config,
 * token and payment implementations live under `server/`. A server→client
 * import means shared code was left in a client file, which would force the
 * browser graph to evaluate server dependencies to get at it.
 */

const webRoot = fileURLToPath(new URL("../../../", import.meta.url));
const srcRoot = resolve(webRoot, "src");

const SERVER_OWNED_DIR = /(^|\/)server\//;
const SERVER_OWNED_SUFFIX = /\.server\.tsx?$/;
const CLIENT_OWNED = /(^|\/)client\//;

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
    return [fullPath];
  });
}

describe("server→client ownership boundary", () => {
  it("keeps server-owned modules from importing client ownership", () => {
    const violations: string[] = [];

    for (const path of collectServerOwned(srcRoot)) {
      const rel = relative(srcRoot, path);
      const parsed = parseFile(path);
      for (const staticImport of parsed.module.staticImports) {
        const specifier = staticImport.moduleRequest.value;
        const names = staticImport.entries.map((entry) => entry.localName.value);
        const targetsClient =
          (specifier.startsWith("@/") && CLIENT_OWNED.test(specifier.slice(2))) ||
          CLIENT_OWNED.test(specifier);
        if (!targetsClient) continue;
        const kind = staticImport.entries.every((entry) => entry.isType) ? "type-only" : "runtime";
        violations.push(
          `${rel} -> ${specifier} (${kind} import of ${names.join(", ") || "module"})`,
        );
      }
    }

    expect(violations).toEqual([]);
  });
});

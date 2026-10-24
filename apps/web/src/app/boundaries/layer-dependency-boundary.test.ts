import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getRuntimeDynamicImports,
  getRuntimeStaticImports,
  getRuntimeStaticReexports,
  getStaticImports,
} from "../../../build/source-analysis/static-imports";

/**
 * Layer dependency direction.
 *
 * - `lib/` is the shared kernel: errors, ids, logging, small pure helpers and
 *   React hooks. It depends on nothing else in `src/`.
 * - `platform/` adapts runtime infrastructure (D1, R2, HTTP, email, LiveKit,
 *   AI). It may use `lib/`, never a feature module or the app shell.
 *
 * - `modules/` are the feature modules. They may use each other (in the
 *   direction module-dependency-boundary.test.ts allows), `lib/`, `platform/`, and
 *   the app shell's request middleware, never `workflows/` above them.
 * - `workflows/` hold work that spans several feature modules (deleting an
 *   account, a Space). Pages, routes, and `app/` sit above everything.
 *
 * Runtime imports only for `modules/`: type-only imports vanish at build
 * time. `lib/` and `platform/` take no types from above either: a platform
 * piece that names a domain's types has started to know that domain.
 */
const srcRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Layers whose type-only imports are held to the same direction. */
const TYPE_STRICT = new Set(["lib", "platform"]);

const LAYERS: Record<string, readonly string[]> = {
  lib: ["lib"],
  platform: ["lib", "platform"],
  modules: ["lib", "platform", "modules", "app"],
};

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(fullPath);
    if (!entry.isFile() || !/\.(tsx?|mts)$/.test(entry.name)) return [];
    return entry.name.includes(".test.") ? [] : [fullPath];
  });
}

/** The top-level `src/` directory a specifier lands in, or null for packages. */
function targetLayer(path: string, specifier: string): string | null {
  const target = specifier.startsWith("@/")
    ? resolve(srcRoot, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(path), specifier)
      : null;
  if (!target) return null;
  const rel = relative(srcRoot, target);
  return rel.startsWith("..") ? null : rel.split("/")[0];
}

describe("layer dependency direction", () => {
  for (const [layer, allowed] of Object.entries(LAYERS)) {
    it(`keeps ${layer}/ depending only on ${allowed.join(", ")}`, () => {
      const violations = collectSourceFiles(join(srcRoot, layer)).flatMap((path) =>
        [
          ...(TYPE_STRICT.has(layer) ? getStaticImports(path) : getRuntimeStaticImports(path)),
          ...getRuntimeStaticReexports(path),
          ...getRuntimeDynamicImports(path),
        ]
          .filter((specifier) => {
            const target = targetLayer(path, specifier);
            return target !== null && !allowed.includes(target);
          })
          .map((specifier) => `${relative(srcRoot, path)} -> ${specifier}`),
      );

      expect(violations).toEqual([]);
    });
  }
});

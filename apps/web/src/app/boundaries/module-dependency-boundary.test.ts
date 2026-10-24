import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getRuntimeDynamicImports,
  getRuntimeStaticImports,
  getRuntimeStaticReexports,
} from "../../../build/source-analysis/static-imports";

/**
 * Feature-module dependency direction.
 *
 * Two feature modules that import each other's implementations are not two
 * modules — they are one, split across two directories, and neither can be
 * changed or reasoned about alone. This test is a ratchet: it pins the cycles
 * that still exist so they cannot grow, and fails the moment a new pair starts
 * importing each other.
 *
 * `contract/` is excluded by design. A module's contract layer is its published
 * surface — shared types, constants and schemas with no implementation behind
 * them — so depending on one is a declaration of shape, not a runtime edge.
 * Type-only imports are excluded for the same reason: they vanish at build time
 * and cannot produce an initialization cycle.
 */
const modulesRoot = fileURLToPath(new URL("../../modules/", import.meta.url));

/**
 * Where cross-domain code lives, so that it does not create new cycles:
 *
 * - Screens that compose several feature modules live in `src/pages/`.
 * - Cron composition, including cleanup that sweeps several domains, lives in
 *   `app/bootstrap/scheduled.server.ts`.
 * - Workflows that act on several modules (deleting an account or a Space) live in
 *   `src/workflows/`, which no module may import.
 * - Small pure helpers other modules need belong in the owner's `contract/`.
 *
 * The two pairs that remain are each one fact read on one side and changed
 * on the other, and are kept on purpose:
 *
 * - `meetings ↔ spaces` — Space membership is an input to meeting authority.
 *   Meetings read it; a membership change (removal, role change, ownership
 *   transfer) pushes the change into open meetings at once, since their own
 *   periodic re-read (AUTHORITY_CHECK_MS) would leave a removed member in for
 *   up to a minute. The membership endpoints are called from spaces/client,
 *   so the push cannot move up to workflows/.
 * - `meetings ↔ whiteboards` — an active participant of a meeting presenting
 *   a board is one of the ways to be authorized for it, so reading, opening,
 *   uploading to and exporting a board consult meetings; a meeting's join,
 *   runtime effects and leave drive its board. Moving the meeting side into
 *   meetings would carry most of whiteboards with it, since those checks sit
 *   under nearly every board operation.
 *
 * Breaking either would mean injecting one side into the other from the app
 * layer: more wiring than the few direct calls it replaces. This list may
 * shrink — never grow.
 */
const KNOWN_CYCLES = [
  "meetings <-> spaces",
  "meetings <-> whiteboards",
];

/**
 * Every set of modules joined by an import loop of any length, which the pairs
 * above cannot show (`a -> b -> c -> a` has no mutually importing pair).
 * Shrinks with the pairs, never grows.
 */
const KNOWN_LOOPS = ["meetings, spaces, whiteboards"];

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(fullPath);
    if (!entry.isFile() || !/\.(?:[cm]?ts|tsx)$/.test(entry.name)) return [];
    return /\.test\.[mt]sx?$/.test(entry.name) ? [] : [fullPath];
  });
}

function resolveLocalSpecifier(fromPath: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? resolve(modulesRoot, "..", specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(fromPath), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.mts"),
    join(base, "index.cts"),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this candidate.
    }
  }
  return null;
}

function moduleTarget(fromPath: string, specifier: string) {
  const targetPath = resolveLocalSpecifier(fromPath, specifier);
  if (!targetPath) return null;
  const pathFromModules = relative(modulesRoot, targetPath);
  if (pathFromModules.startsWith("..")) return null;
  const [name, firstDirectory] = pathFromModules.split(/[\\/]/);
  return { name, isContract: firstDirectory === "contract" };
}

function buildModuleGraph(): Map<string, Set<string>> {
  const moduleNames = readdirSync(modulesRoot).filter((entry) =>
    statSync(join(modulesRoot, entry)).isDirectory(),
  );
  const graph = new Map(moduleNames.map((name) => [name, new Set<string>()]));

  for (const name of moduleNames) {
    for (const path of collectSourceFiles(join(modulesRoot, name))) {
      const specifiers = [
        ...getRuntimeStaticImports(path),
        ...getRuntimeStaticReexports(path),
        ...getRuntimeDynamicImports(path),
      ];
      for (const specifier of specifiers) {
        const target = moduleTarget(path, specifier);
        if (!target || target.name === name || target.isContract) continue;
        graph.get(name)?.add(target.name);
      }
    }
  }
  return graph;
}

/**
 * Modules that reach one another through any chain of imports, however long:
 * the graph's strongly connected components with more than one member
 * (Tarjan's algorithm), each sorted, as `a, b, c`.
 */
function moduleLoops(graph: Map<string, Set<string>>): string[] {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const loops: string[] = [];

  const visit = (node: string) => {
    index.set(node, index.size);
    lowLink.set(node, index.get(node)!);
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(next)!));
      } else if (onStack.has(next)) {
        lowLink.set(node, Math.min(lowLink.get(node)!, index.get(next)!));
      }
    }
    if (lowLink.get(node) !== index.get(node)) return;
    const members: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      members.push(member);
    } while (member !== node);
    if (members.length > 1) loops.push(members.sort().join(", "));
  };

  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return loops.sort();
}

/**
 * A module's published server surface: the files under `modules/<m>/server/`
 * that other feature modules import at runtime. Everything else there is the
 * module's own. The surface is explicit rather than a barrel because a barrel
 * would load a module's whole server graph wherever one of its functions is
 * needed, cold paths such as the raw /api dispatcher included.
 *
 * Adding a file is a decision to publish it; prefer the module's contract/
 * layer for shapes and pure helpers. This list may shrink freely.
 */
const PUBLISHED_SERVER_FILES: Record<string, readonly string[]> = {
  assets: [
    "server/content-disposition",
    "server/finalize-space-pdf",
    "server/immutable-upload",
    "server/promotion-intent",
    "server/r2-cleanup.server",
    "server/r2-client.server",
    "server/r2-storage",
    "server/register",
    "server/signed-urls.server",
    "server/storage",
    "server/upload-headers",
    "server/upload-reservations",
  ],
  billing: [
    "server/entitlements.server",
    "server/paddle",
    "server/paddle-config",
  ],
  contacts: [
    "server/contact-index",
  ],
  identity: [
    "server/session",
    "server/step-up.server",
  ],
  meetings: [
    "server/access/access-assertions",
    "server/access/guest-admission",
    "server/access/guest-cookie.server",
    "server/access/resource-access",
    "server/connection/state",
    "server/history/summary-generation-policy",
    "server/room/connection-queries",
    "server/runtime/client.server",
    "server/runtime/revoke.server",
    "server/space-default-meeting-link.server",
  ],
  organizations: [
    "server/authority.server",
  ],
  spaces: [
    "server/files.functions",
    "server/helpers",
    "server/personal",
  ],
  whiteboards: [
    "server/config.server",
    "server/document-revisions",
    "server/documents",
    "server/handout-pages",
    "server/meeting/authority.server",
    "server/meeting/capture",
    "server/meeting/grants",
    "server/orchestration.server",
    "server/sync-commands.server",
  ],
};

/** Each module's server files other feature modules import, as `server/<path>` without extension. */
function importedServerSurface(): Record<string, string[]> {
  const surface = new Map<string, Set<string>>();
  for (const name of readdirSync(modulesRoot)) {
    if (!statSync(join(modulesRoot, name)).isDirectory()) continue;
    for (const path of collectSourceFiles(join(modulesRoot, name))) {
      for (const specifier of [
        ...getRuntimeStaticImports(path),
        ...getRuntimeStaticReexports(path),
        ...getRuntimeDynamicImports(path),
      ]) {
        const targetPath = resolveLocalSpecifier(path, specifier);
        if (!targetPath) continue;
        const [target, layer, ...rest] = relative(modulesRoot, targetPath).split(/[\\/]/);
        if (!rest.length || target === name || layer !== "server") continue;
        const file = [layer, ...rest].join("/").replace(/\.(?:[cm]?ts|tsx)$/, "");
        if (!surface.has(target)) surface.set(target, new Set());
        surface.get(target)!.add(file);
      }
    }
  }
  return Object.fromEntries([...surface].sort().map(([name, files]) => [name, [...files].sort()]));
}

describe("feature module dependency direction", () => {
  it("reaches other modules' servers only through their published files", () => {
    expect(importedServerSurface()).toEqual(PUBLISHED_SERVER_FILES);
  });

  it("has no mutually importing pair beyond the known, shrinking set", () => {
    const graph = buildModuleGraph();
    const cycles = [...graph]
      .flatMap(([from, targets]) =>
        [...targets]
          .filter((to) => from < to && graph.get(to)?.has(from))
          .map((to) => `${from} <-> ${to}`),
      )
      .sort();

    expect(cycles).toEqual(KNOWN_CYCLES);
  });

  it("has no import loop, of any length, beyond the known, shrinking set", () => {
    expect(moduleLoops(buildModuleGraph())).toEqual(KNOWN_LOOPS);
  });

  it("keeps every module's contract layer free of cross-module implementation imports", () => {
    const violations: string[] = [];
    for (const name of readdirSync(modulesRoot)) {
      const contractDir = join(modulesRoot, name, "contract");
      let isDirectory = false;
      try {
        isDirectory = statSync(contractDir).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory) continue;

      for (const path of collectSourceFiles(contractDir)) {
        const dependencies = [
          ...getRuntimeStaticImports(path),
          ...getRuntimeStaticReexports(path),
          ...getRuntimeDynamicImports(path),
        ];
        for (const specifier of dependencies) {
          const target = moduleTarget(path, specifier);
          if (!target || target.name === name || target.isContract) continue;
          violations.push(`${name}/contract -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

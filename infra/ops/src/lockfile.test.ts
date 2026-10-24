import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./catalog.ts";
import { lockfileSlice } from "./lockfile.ts";

const pinnedPnpm = `---
lockfileVersion: '9.0'

importers:
  .:
    configDependencies: {}
`;

function lockfile({ webReact = "19.3.0", serverZod = "4.1.0" } = {}) {
  return `${pinnedPnpm}
---
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:
  apps/server:
    dependencies:
      '@x/shared':
        specifier: workspace:*
        version: link:../../packages/shared
      zod:
        specifier: ^4.0.0
        version: ${serverZod}
    devDependencies:
      typescript:
        specifier: 'catalog:'
        version: 7.0.2
  apps/web:
    dependencies:
      react:
        specifier: ^19.0.0
        version: ${webReact}
  packages/shared:
    dependencies:
      ts6:
        specifier: npm:@typescript/typescript6@6.0.2
        version: '@typescript/typescript6@6.0.2'

packages: {}

snapshots:

  zod@${serverZod}:
    dependencies:
      tiny: 1.0.0

  tiny@1.0.0: {}

  '@typescript/typescript6@6.0.2': {}

  typescript@7.0.2: {}

  react@${webReact}: {}
`;
}

const slice = (text: string, prod = true) => JSON.parse(lockfileSlice(text, ["apps/server"], { prod })) as [string, unknown][];
const keys = (text: string, prod = true) => slice(text, prod).map(([key]) => key);

describe("lockfileSlice", () => {
  it("follows linked workspace packages, transitive dependencies and npm aliases", () => {
    expect(keys(lockfile())).toEqual([
      "@typescript/typescript6@6.0.2",
      "importer apps/server",
      "importer packages/shared",
      "overrides",
      "settings",
      "tiny@1.0.0",
      "zod@4.1.0",
    ]);
  });

  it("is unchanged by a dependency change in another workspace package", () => {
    expect(lockfileSlice(lockfile({ webReact: "19.4.0" }), ["apps/server"], { prod: true }))
      .toBe(lockfileSlice(lockfile(), ["apps/server"], { prod: true }));
  });

  it("changes with a dependency of its own", () => {
    expect(lockfileSlice(lockfile({ serverZod: "4.2.0" }), ["apps/server"], { prod: true }))
      .not.toBe(lockfileSlice(lockfile(), ["apps/server"], { prod: true }));
  });

  it("leaves devDependencies out of a production install", () => {
    expect(keys(lockfile())).not.toContain("typescript@7.0.2");
    expect(keys(lockfile(), false)).toContain("typescript@7.0.2");
  });

  it("reads this repository's lockfile", () => {
    const text = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
    const found = (JSON.parse(lockfileSlice(text, ["apps/whiteboard-server"], { prod: true })) as [string][])
      .map(([key]) => key);
    expect(found).toContain("importer apps/whiteboard-server");
    expect(found).toContain("importer packages/whiteboard-core");
    expect(found.some((key) => key.startsWith("@tldraw/sync-core@"))).toBe(true);
    expect(found.some((key) => key.startsWith("react-dom@"))).toBe(true);
    expect(found.some((key) => key.startsWith("@tanstack/react-start@"))).toBe(false);
  });
});

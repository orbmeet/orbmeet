/**
 * The one StyleX compiler configuration.
 *
 * Imported by `apps/web/vite.config.ts` and by every Vitest project that
 * renders a component. Both have to agree: the plugin hashes variable names
 * from a file's *canonical* path, so a test compiled with a different
 * `rootDir` or a different alias table would generate a different
 * `--x…` for the same token and quietly assert against styles the app never
 * ships.
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { LIGHTNINGCSS_TARGETS } from "./apps/web/src/app/shell/browser-support.ts";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

const webSrc = join(rootDir, "apps/web/src");

/**
 * Every tree StyleX compiles. The workspace packages render markup and define
 * tokens, so they have to be compiled as app code even though pnpm links them
 * through node_modules.
 *
 * The patterns are absolute on purpose: unplugin resolves a relative one
 * against `process.cwd()`, which is wherever the invoking command happened to
 * run from — repo root for the workspace test run, the package directory for
 * `pnpm -C <pkg> test`. Absolute patterns match identically from both.
 */
const styleSources = [
  webSrc,
  join(rootDir, "packages/ui/src"),
  join(rootDir, "packages/whiteboard-client/src"),
];

export const stylexOptions = {
  unstable_moduleResolution: { type: "commonJS" as const, rootDir },
  // StyleX resolves token imports itself, with its own resolver, so it has to
  // be told about the `@/` alias separately from Vite.
  aliases: { "@/*": [join(webSrc, "*")] },
  include: styleSources.flatMap((dir) => [
    join(dir, "**/*.ts"),
    join(dir, "**/*.tsx"),
  ]),
  // Styles must survive into the bundle even when a module's only export looks
  // unused to the tree-shaker.
  treeshakeCompensation: true,
  // The oldest browsers the app supports, derived from the platform features
  // it needs (apps/web/src/app/shell/browser-support.ts). Left to
  // browserslist's defaults, Lightning CSS would rewrite every `light-dark()`
  // token into a polyfill that resolves at the root, so a subtree that pins
  // `color-scheme: light` (the board) would still get dark colours.
  lightningcssOptions: { targets: LIGHTNINGCSS_TARGETS },
};

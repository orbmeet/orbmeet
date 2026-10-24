import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { sanitizeStaticPrerenderHtml } from "./static-prerender-html.ts";

function collectFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    return entry.isDirectory() ? collectFiles(fullPath) : [fullPath];
  });
}

/**
 * Sanitizes immutable prerenders and rejects local-only files after TanStack
 * Start has emitted every build artifact.
 */
export function finalizeBuildArtifacts(): Plugin {
  return {
    name: "finalize-build-artifacts",
    apply: "build",
    enforce: "post",
    buildApp: {
      order: "post",
      async handler() {
        // The Cloudflare plugin emits the Build Output API tree; sweep every
        // Worker's directory (the prerender Worker's assets too).
        const outputDir = fileURLToPath(
          new URL("../../.cloudflare/output", import.meta.url),
        );
        const files = collectFiles(outputDir);

        // Public prerenders are immutable Assets and never pass through the
        // Worker's nonce replacement.
        for (const file of files) {
          if (!file.endsWith(".html")) continue;
          const source = readFileSync(file, "utf8");
          const sanitized = sanitizeStaticPrerenderHtml(source);
          if (sanitized !== source) writeFileSync(file, sanitized);
        }

        const forbiddenArtifacts = (file: string) => {
          const name = basename(file);
          return name.startsWith(".dev.vars") || name === ".DS_Store";
        };
        for (const file of files.filter(forbiddenArtifacts)) {
          rmSync(file, { force: true });
        }

        const remaining = collectFiles(outputDir).filter(forbiddenArtifacts);
        if (remaining.length > 0) {
          throw new Error(
            `Build output contains forbidden artifacts: ${remaining.join(", ")}`,
          );
        }
      },
    },
  };
}

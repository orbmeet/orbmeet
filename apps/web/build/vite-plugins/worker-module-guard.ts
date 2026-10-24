import type { Plugin } from "vite";

const forbiddenDependencies = new Map<string, string>([
  ["livekit-client", "LiveKit browser capture belongs in the browser entry."],
  ["@livekit/components-react", "LiveKit components belong in the browser entry."],
  ["@livekit/track-processors", "Media processors belong in the browser entry."],
  ["@simplewebauthn/browser", "WebAuthn browser code belongs in the browser entry."],
  ["tldraw", "The editor belongs in the browser entry."],
  ["@tldraw/sync", "The sync client belongs in the browser entry."],
  ["@vidstack/react", "The media player belongs in the browser entry."],
]);

/** Return the package name from either a flat or pnpm real path. */
export function dependencyNameFromModuleId(moduleId: string): string | undefined {
  const cleanId = moduleId.split("?", 1)[0].replaceAll("\\", "/");
  const marker = "/node_modules/";
  const index = cleanId.lastIndexOf(marker);
  if (index === -1) return undefined;

  const segments = cleanId.slice(index + marker.length).split("/");
  if (!segments[0]) return undefined;
  return segments[0].startsWith("@")
    ? segments.length > 1 ? `${segments[0]}/${segments[1]}` : undefined
    : segments[0];
}

export function forbiddenWorkerDependencyReason(moduleId: string): string | undefined {
  const dependency = dependencyNameFromModuleId(moduleId);
  if (!dependency) return undefined;

  return forbiddenDependencies.get(dependency);
}

/**
 * Reject browser-only or superseded packages while Vite still has resolved
 * module IDs. Production minification removes those IDs from emitted code, so
 * a post-build text search alone cannot enforce this boundary.
 */
export function workerModuleGuard(): Plugin {
  return {
    name: "worker-module-guard",
    enforce: "post",
    generateBundle(_options, bundle) {
      if (this.environment.config.consumer !== "server") return;
      // Inspect surviving modules. Shared UI barrels can reference browser
      // exports that tree shaking removes; only emitted code is a violation.
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const [id, module] of Object.entries(output.modules)) {
          if (module.renderedLength === 0) continue;
          const reason = forbiddenWorkerDependencyReason(id);
          if (reason) this.error(`${id}: ${reason}`);
        }
      }
    },
  };
}

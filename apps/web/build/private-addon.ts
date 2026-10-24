import { existsSync } from "node:fs";
import type { PluginOption } from "vite";

// The private tldraw license override: gitignored, so absent in OSS clones.
const override = new URL(
  "../../../packages/whiteboard-client/src/overrides/tldraw-license-build.mjs",
  import.meta.url,
);

/** The Vite plugins the private override contributes; none without it. */
export async function privateAddonPlugins(): Promise<PluginOption[]> {
  if (!existsSync(override)) return [];
  const { createTldrawLicensePlugins } = (await import(override.href)) as {
    createTldrawLicensePlugins: () => PluginOption[];
  };
  return createTldrawLicensePlugins();
}

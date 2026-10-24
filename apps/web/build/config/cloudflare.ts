import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { ParsedInputWorkerConfig, R2Binding } from "@cloudflare/config";
import type { PluginConfig } from "@cloudflare/vite-plugin";
import { deployVars } from "./worker-target.ts";

/**
 * Resolves the scratch bucket a dev server may write to for real, or null
 * when `.dev.vars` carries no usable R2 credentials and local simulation
 * should be used instead.
 */
export function resolveRemoteDevBucket(devVarsSource: string): string | null {
  const values = parseEnv(devVarsSource);
  const accessKeyId = values.R2_ACCESS_KEY_ID;
  const secretAccessKey = values.R2_SECRET_ACCESS_KEY;
  const bucketName = values.R2_BUCKET_NAME;
  if (!accessKeyId || !secretAccessKey || !bucketName) return null;

  if (bucketName === deployVars.R2_BUCKET_NAME) {
    throw new Error(
      `R2_BUCKET_NAME in .dev.vars is "${bucketName}", the bucket cloudflare.config.ts deploys to. ` +
        "A remote dev binding writes to it for real; point it at a scratch bucket " +
        "(e.g. orbmeet-storage-dev) or clear the R2 credentials to use local storage.",
    );
  }

  return bucketName;
}

/**
 * Dev-server-only plugin options restoring what Wrangler's dev server used to
 * do by itself:
 *
 * 1. `.dev.vars` overrides the plain-text bindings (the v2 plugin resolves
 *    declared secrets from it but passes configured text bindings through
 *    untouched), and keys the config does not declare — optional integration
 *    secrets, CODE_RUNNER_URL, ... — become dev-only env vars.
 * 2. The R2_BUCKET binding points at the scratch bucket from `.dev.vars` as a
 *    remote binding: real storage, real reads, without touching the deployed
 *    bucket.
 *
 * Applied through the plugin's `config` customizer, which only runs for the
 * dev server — `vite build` keeps the committed production bindings.
 */
export function localDevBindingOverrides(
  devVarsUrl: URL,
): PluginConfig | undefined {
  if (!existsSync(devVarsUrl)) return undefined;

  const devVarsSource = readFileSync(devVarsUrl, "utf8");
  const devVars = parseEnv(devVarsSource) as Record<string, string>;
  const bucketName = resolveRemoteDevBucket(devVarsSource);

  return {
    remoteBindings: bucketName ? true : undefined,
    config(workerConfig) {
      const env: Record<string, unknown> = { ...workerConfig.env };
      for (const [name, value] of Object.entries(devVars)) {
        const binding = env[name] as { type?: string } | undefined;
        // Declared secrets are resolved from .dev.vars by the plugin itself.
        if (binding?.type === "secret") continue;
        env[name] = { type: "text", value };
      }

      if (bucketName) {
        const binding = env.R2_BUCKET as R2Binding | undefined;
        if (binding?.type === "r2") {
          env.R2_BUCKET = { ...binding, name: bucketName, dev: { remote: true } };
        }
      }

      return { env: env as ParsedInputWorkerConfig["env"] };
    },
  };
}

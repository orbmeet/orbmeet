import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { deployVars } from "../../build/config/worker-target.ts";

type EnvLike = Record<string, string | undefined>;

export interface ClientVarOptions {
  devVarsUrl?: URL;
  env?: EnvLike;
  useDevVars?: boolean;
}

const devVarsCache = new Map<string, Record<string, string>>();

function getConfigVars(): Record<string, string> {
  return deployVars;
}

function getDevVars(devVarsUrl: URL | undefined): Record<string, string> {
  if (!devVarsUrl) return {};

  const cacheKey = devVarsUrl.href;
  const cached = devVarsCache.get(cacheKey);
  if (cached) return cached;

  if (!existsSync(devVarsUrl)) {
    devVarsCache.set(cacheKey, {});
    return {};
  }

  const vars = parseEnv(readFileSync(devVarsUrl, "utf8")) as Record<string, string>;
  devVarsCache.set(cacheKey, vars);
  return vars;
}

export function readClientVar(
  name: string,
  fallbackName: string | undefined,
  options: ClientVarOptions,
): string | undefined {
  const env = options.env ?? process.env;
  const devVars = options.useDevVars ? getDevVars(options.devVarsUrl) : {};
  const configVars = getConfigVars();

  return (
    env[name] ??
    (fallbackName ? env[fallbackName] : undefined) ??
    devVars[name] ??
    (fallbackName ? devVars[fallbackName] : undefined) ??
    configVars[name] ??
    (fallbackName ? configVars[fallbackName] : undefined)
  );
}

import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { errorCode } from "./errors.ts";

export interface CliConfig {
  url: string;
  token: string;
}

export const CLOUD_API_URL = "https://orbmeet.com";
export const CONFIG_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "orbmeet",
  "config.json",
);

async function readStoredToken(): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(CONFIG_PATH, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(text);
  } catch {
    throw new Error(
      `The config file at ${CONFIG_PATH} is not valid JSON. Re-run: orbmeet configure --token-file <path>`,
    );
  }
  if (typeof stored !== "object" || stored === null) return undefined;
  const { token } = stored as { token?: unknown };
  return token === undefined || token === null ? undefined : String(token);
}

export async function readConfig(): Promise<CliConfig> {
  const token = process.env.ORBMEET_TOKEN || await readStoredToken();
  if (!token) {
    throw new Error("Orb Meet is not configured. Pipe a token to: orbmeet configure");
  }
  return { url: CLOUD_API_URL, token };
}

export async function saveToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("The API token must not be empty");
  const configDirectory = dirname(CONFIG_PATH);
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);

  // Keep readers on the previous complete file until the replacement is fully
  // written and durable. A unique sibling also makes concurrent configure
  // commands safe: each rename publishes one complete JSON document.
  const temporaryPath = join(configDirectory, `.config-${randomUUID()}.tmp`);
  let temporaryFile;
  try {
    temporaryFile = await open(temporaryPath, "wx", 0o600);
    await temporaryFile.writeFile(`${JSON.stringify({ token: trimmed }, null, 2)}\n`, "utf8");
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, CONFIG_PATH);
    await chmod(CONFIG_PATH, 0o600);
  } catch (error) {
    await temporaryFile?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

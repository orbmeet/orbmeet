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

/**
 * Text from a token file or a pipe. Windows PowerShell 5.1 writes UTF-16 with
 * a byte-order mark for `>` and `Out-File`; read as UTF-8, that is a token of
 * NUL bytes and replacement characters. The mark says which encoding it is.
 */
export function decodeTokenText(bytes: Uint8Array): string {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  // Every decoder drops its own byte-order mark.
  return new TextDecoder(encoding).decode(bytes);
}

/**
 * Everything piped in, or null when `silentAfterMs` is given and nothing has
 * arrived by then. A pipe cannot say whether anything is coming: Git Bash's
 * terminal on Windows (mintty) hands programs one that never ends, so a reader
 * with somewhere else to turn must give up on a silent one. It is closed then,
 * so it holds nothing open.
 */
export function readPiped(
  input: NodeJS.ReadableStream & { destroy(): void },
  silentAfterMs?: number,
): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const silence = silentAfterMs === undefined
      ? null
      : setTimeout(() => {
          stop();
          input.destroy();
          resolve(null);
        }, silentAfterMs);
    const onData = (chunk: string | Buffer) => {
      if (silence) clearTimeout(silence);
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => {
      stop();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: unknown) => {
      stop();
      reject(error);
    };
    function stop() {
      if (silence) clearTimeout(silence);
      input.off("data", onData).off("end", onEnd).off("error", onError);
    }
    input.on("data", onData).on("end", onEnd).on("error", onError);
  });
}

/** An API token travels in an HTTP header, so it is visible ASCII with no spaces. */
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

export async function saveToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("The API token must not be empty");
  if (!TOKEN_SHAPE.test(trimmed)) {
    throw new Error(
      "That is not an Orb Meet API token: it has spaces or characters outside ASCII. Copy the token again from Settings, Developer API.",
    );
  }
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

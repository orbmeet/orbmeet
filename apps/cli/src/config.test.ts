import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let configDir: string;

// CONFIG_PATH is computed at import time from XDG_CONFIG_HOME, so each test
// loads a fresh module instance pointed at its own temp directory.
async function loadConfig() {
  vi.resetModules();
  return import("./config.ts");
}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "orbmeet-cli-config-"));
  process.env.XDG_CONFIG_HOME = configDir;
  delete process.env.ORBMEET_TOKEN;
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.ORBMEET_TOKEN;
});

describe("saveToken and readConfig", () => {
  it("round-trips the token through a 0600 config file", async () => {
    const { saveToken, readConfig, CONFIG_PATH } = await loadConfig();
    await saveToken("  pat_secret  ");
    expect(JSON.parse(await readFile(CONFIG_PATH, "utf8"))).toEqual({ token: "pat_secret" });
    expect((await stat(CONFIG_PATH)).mode & 0o777).toBe(0o600);
    await expect(readConfig()).resolves.toEqual({
      url: "https://orbmeet.com",
      token: "pat_secret",
    });
  });

  it("rejects an empty token", async () => {
    const { saveToken } = await loadConfig();
    await expect(saveToken("   ")).rejects.toThrow("The API token must not be empty");
  });

  it("explains how to configure when nothing is stored", async () => {
    const { readConfig } = await loadConfig();
    await expect(readConfig()).rejects.toThrow(
      "Orb Meet is not configured. Pipe a token to: orbmeet configure",
    );
  });

  it("names the config file when it holds invalid JSON", async () => {
    const { readConfig, CONFIG_PATH } = await loadConfig();
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, "{not json");
    await expect(readConfig()).rejects.toThrow(
      `The config file at ${CONFIG_PATH} is not valid JSON. Re-run: orbmeet configure --token-file <path>`,
    );
  });

  it("lets ORBMEET_TOKEN override the stored file, even a broken one", async () => {
    const { readConfig, CONFIG_PATH } = await loadConfig();
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, "{not json");
    process.env.ORBMEET_TOKEN = "env-token";
    await expect(readConfig()).resolves.toMatchObject({ token: "env-token" });
  });

  it("enforces 0o700 directory permissions and 0o600 file permissions for stored credentials", async () => {
    const { saveToken, CONFIG_PATH } = await loadConfig();
    await saveToken("secret_token_123");
    const dirStats = await stat(dirname(CONFIG_PATH));
    const fileStats = await stat(CONFIG_PATH);

    expect(dirStats.mode & 0o777).toBe(0o700);
    expect(fileStats.mode & 0o777).toBe(0o600);
  });

  it("publishes complete JSON when configure commands overlap", async () => {
    const { saveToken, CONFIG_PATH } = await loadConfig();
    await Promise.all(Array.from({ length: 20 }, (_, index) => saveToken(`token_${index}`)));

    const stored = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as { token: string };
    expect(stored.token).toMatch(/^token_\d+$/);
  });
});

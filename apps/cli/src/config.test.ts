import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

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
  delete process.env.ORBMEET_API_URL;
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.ORBMEET_TOKEN;
  delete process.env.ORBMEET_API_URL;
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

  it("trims ORBMEET_TOKEN as configure trims what it stores, so a secret ending in a newline still works", async () => {
    const { readConfig } = await loadConfig();
    process.env.ORBMEET_TOKEN = "env-token\n";
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

  it("lets ORBMEET_API_URL override the API base URL and trims trailing slashes", async () => {
    const { readConfig } = await loadConfig();
    process.env.ORBMEET_TOKEN = "env-token";
    process.env.ORBMEET_API_URL = "https://staging.orbmeet.com///";
    await expect(readConfig()).resolves.toEqual({
      url: "https://staging.orbmeet.com",
      token: "env-token",
    });
  });

  it("rejects non-HTTP(S) ORBMEET_API_URL values", async () => {
    const { readConfig } = await loadConfig();
    process.env.ORBMEET_TOKEN = "env-token";
    process.env.ORBMEET_API_URL = "ftp://example.com";
    await expect(readConfig()).rejects.toThrow("ORBMEET_API_URL");
    process.env.ORBMEET_API_URL = "not-a-url";
    await expect(readConfig()).rejects.toThrow("ORBMEET_API_URL");
  });

  it("sends the token in clear only to this machine", async () => {
    const { readConfig } = await loadConfig();
    process.env.ORBMEET_TOKEN = "env-token";
    process.env.ORBMEET_API_URL = "http://staging.orbmeet.com";
    await expect(readConfig()).rejects.toThrow("https://");
    for (const local of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      process.env.ORBMEET_API_URL = local;
      await expect(readConfig()).resolves.toEqual({ url: local, token: "env-token" });
    }
  });

  it("rejects ORBMEET_API_URL values that request paths cannot be appended to", async () => {
    const { readConfig } = await loadConfig();
    process.env.ORBMEET_TOKEN = "env-token";
    for (const value of ["https://orbmeet.test/?x=1", "https://orbmeet.test/#top", "https://user:pw@orbmeet.test"]) {
      process.env.ORBMEET_API_URL = value;
      await expect(readConfig()).rejects.toThrow("base URL");
    }
  });

  it("publishes complete JSON when configure commands overlap", async () => {
    const { saveToken, CONFIG_PATH } = await loadConfig();
    await Promise.all(Array.from({ length: 20 }, (_, index) => saveToken(`token_${index}`)));

    const stored = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as { token: string };
    expect(stored.token).toMatch(/^token_\d+$/);
  });
});

describe("token text", () => {
  it("reads the UTF-16 file Windows PowerShell 5.1 writes for `\"…\" > token.txt`", async () => {
    const { decodeTokenText } = await loadConfig();
    const powershell = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("orbmeet_pat.abc123\r\n", "utf16le")]);
    expect(decodeTokenText(powershell).trim()).toBe("orbmeet_pat.abc123");
  });

  it("reads UTF-8 with or without a byte-order mark, and big-endian UTF-16", async () => {
    const { decodeTokenText } = await loadConfig();
    expect(decodeTokenText(Buffer.from("orbmeet_pat.abc\n"))).toBe("orbmeet_pat.abc\n");
    expect(decodeTokenText(Buffer.from("﻿orbmeet_pat.abc", "utf8"))).toBe("orbmeet_pat.abc");
    const bigEndian = Buffer.from("﻿orbmeet_pat.abc", "utf16le").swap16();
    expect(decodeTokenText(bigEndian)).toBe("orbmeet_pat.abc");
  });

  it("refuses to store what could never be sent in a header, rather than reporting success", async () => {
    const { saveToken } = await loadConfig();
    await expect(saveToken("��o\u0000m\u0000")).rejects.toThrow("not an Orb Meet API token");
    await expect(saveToken("orbmeet_pat abc")).rejects.toThrow("not an Orb Meet API token");
  });
});

describe("orbmeet configure", () => {
  it("stores ORBMEET_TOKEN without waiting on a stdin that never ends, as in Git Bash", async () => {
    const { spawn } = await import("node:child_process");
    const bin = join(import.meta.dirname, "../bin/orbmeet.ts");
    // A pipe nobody writes to or closes: what mintty gives a program.
    const child = spawn(process.execPath, [bin, "configure"], {
      env: { ...process.env, XDG_CONFIG_HOME: configDir, ORBMEET_TOKEN: "orbmeet_pat.fromenv" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const timedOut = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000));
    const outcome = await Promise.race([exited, timedOut]);
    child.kill();
    expect(outcome).toBe(0);
    const stored = JSON.parse(await readFile(join(configDir, "orbmeet", "config.json"), "utf8")) as { token: string };
    expect(stored.token).toBe("orbmeet_pat.fromenv");
  }, 15_000);
});

describe("readPiped", () => {
  it("reads a pipe to its end", async () => {
    const { readPiped } = await loadConfig();
    const input = new PassThrough();
    const read = readPiped(input, 500);
    input.end("pat_piped\n");
    expect(new TextDecoder().decode((await read)!)).toBe("pat_piped\n");
  });

  it("keeps reading a pipe that has spoken, however slow its end", async () => {
    vi.useFakeTimers();
    try {
      const { readPiped } = await loadConfig();
      const input = new PassThrough();
      const read = readPiped(input, 500);
      input.write("pat_");
      await vi.advanceTimersByTimeAsync(5_000);
      input.end("slow");
      expect(new TextDecoder().decode((await read)!)).toBe("pat_slow");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on, and closes, a pipe that stays silent", async () => {
    vi.useFakeTimers();
    try {
      const { readPiped } = await loadConfig();
      const input = new PassThrough();
      const read = readPiped(input, 500);
      await vi.advanceTimersByTimeAsync(500);
      await expect(read).resolves.toBeNull();
      expect(input.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

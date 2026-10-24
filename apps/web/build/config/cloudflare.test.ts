import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../../cloudflare.config.ts";
import { DAILY_CRON, MINUTELY_CRON } from "../../src/app/bootstrap/cron-schedules.ts";
import {
  RECORDING_UPLOAD_MAX_RETRIES,
  RECORDINGS_QUEUE_NAME,
} from "../../src/modules/meetings/server/media/recordings-queue.ts";
import { resolveRemoteDevBucket } from "./cloudflare.ts";

describe("Cloudflare build configuration", () => {
  it("sources the D1 test runtime from the committed config", () => {
    // vitest.d1.config.ts feeds miniflare from the same module; this pins the
    // compatibility settings the D1 ledger stays byte-compatible with.
    expect(config.worker?.compatibilityDate).toBe("2026-03-29");
    expect(config.worker?.compatibilityFlags).toEqual(["nodejs_compat"]);
  });

  it("enables remote R2 only when all credentials select a scratch bucket", () => {
    expect(
      resolveRemoteDevBucket(
        "R2_ACCESS_KEY_ID=key\nR2_SECRET_ACCESS_KEY=secret\nR2_BUCKET_NAME=scratch\n",
      ),
    ).toBe("scratch");
    expect(resolveRemoteDevBucket("R2_BUCKET_NAME=scratch\n")).toBeNull();
  });

  it("refuses to point local development at the deployed bucket", () => {
    expect(() =>
      resolveRemoteDevBucket(
        "R2_ACCESS_KEY_ID=key\nR2_SECRET_ACCESS_KEY=secret\nR2_BUCKET_NAME=orbmeet-storage\n",
      ),
    ).toThrow(/writes to it for real/);
  });

  it("imports nothing from src/ but the Worker entry's types", () => {
    // The Vite plugin denies the dev server — and with it the dev Worker's
    // module loader — every file this config imports. A src/ module imported
    // here fails to load in `vite dev` wherever the app imports it too.
    const source = readFileSync(new URL("../../cloudflare.config.ts", import.meta.url), "utf8");
    const fromSrc = [...source.matchAll(/^import[^;]*?from\s+"(\.\/src\/[^"]+)"([^;]*);/gms)];
    expect(fromSrc.map(([, path, attributes]) => [path, attributes.trim()])).toEqual([
      ["./src/worker-entry.ts", 'with { type: "cf-worker" }'],
    ]);
  });

  it("declares the triggers the Worker dispatches on", () => {
    // Written out in the config (see the test above); pinned to the app here.
    expect(config.worker?.triggers).toEqual([
      { type: "scheduled", schedule: MINUTELY_CRON },
      { type: "scheduled", schedule: DAILY_CRON },
      { type: "queue", name: RECORDINGS_QUEUE_NAME, maxRetries: RECORDING_UPLOAD_MAX_RETRIES },
    ]);
  });
});

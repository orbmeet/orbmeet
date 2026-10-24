import type { D1Migration } from "@cloudflare/vitest-plugin";
import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { afterEach, beforeEach, vi } from "vitest";

// Serial tasks run in-process, against the test's D1 (see ./serial.ts).
vi.mock("@/app/serial/serial", async (original) => ({
  ...(await original<object>()),
  runSerially: (await import("./serial")).runSeriallyInProcess,
}));

type D1TestEnv = Env & {
  TEST_MIGRATIONS: D1Migration[];
};

beforeEach(async () => {
  const testEnv = env as D1TestEnv;
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

afterEach(async () => {
  await reset();
});

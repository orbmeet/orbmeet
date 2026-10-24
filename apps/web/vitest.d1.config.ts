import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import {
  compatibilityDate,
  compatibilityFlags,
} from "./build/config/worker-target.ts";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/db/drizzle/migrations",
);

// Drizzle nests each migration in its own timestamped directory, so discover
// the nested `*/migration.sql` layout the way Wrangler does; the resulting
// path-qualified names keep the test ledger byte-for-byte compatible with the
// remote ledger.
const migrations = await readD1Migrations({
  projectPath: migrationsDir,
  migrationsDir: ".",
  migrationsPattern: "*/migration.sql",
});
const latestMigration = migrations.at(-1);
if (!latestMigration) throw new Error("No D1 migrations found");

const schemaSnapshot = JSON.parse(
  readFileSync(
    join(migrationsDir, dirname(latestMigration.name), "snapshot.json"),
    "utf8",
  ),
);
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate,
        compatibilityFlags: [...compatibilityFlags],
        d1Databases: ["DB"],
        bindings: {
          TEST_MIGRATIONS: migrations,
          TEST_SCHEMA_SNAPSHOT: schemaSnapshot,
        },
      },
    }),
    tanstackStart(),
  ],
  test: {
    name: "web-d1",
    include: ["src/**/*.d1.test.{ts,tsx}"],
    setupFiles: ["./src/test/d1-setup.ts"],
    testTimeout: 15_000,
  },
  root: import.meta.dirname,
  resolve: {
    tsconfigPaths: true,
  },
});

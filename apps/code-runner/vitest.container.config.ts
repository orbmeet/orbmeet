import { defineConfig } from "vitest/config";

/**
 * The opt-in container suite. Separate from vitest.config.ts because it needs
 * Docker and the image, which the default `pnpm test` gate must not.
 */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "code-runner-container",
    environment: "node",
    include: ["test/**/*.test.ts"],
    // One container per file, and they would contend for the same half vCPU.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});

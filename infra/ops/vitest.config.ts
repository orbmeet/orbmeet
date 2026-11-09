import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "ops",
    environment: "node",
    // Rendering every node is CPU-bound, and this suite runs beside all the others.
    testTimeout: 30_000,
  },
});

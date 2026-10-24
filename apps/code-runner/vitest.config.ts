import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "code-runner",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

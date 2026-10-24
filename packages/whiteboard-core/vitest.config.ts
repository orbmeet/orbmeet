import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "whiteboard-contract",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

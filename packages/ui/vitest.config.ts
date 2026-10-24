import stylex from "@stylexjs/unplugin";
import { defineConfig } from "vitest/config";

import { stylexOptions } from "../../stylex.config.ts";

export default defineConfig({
  root: import.meta.dirname,
  // Component tests need StyleX's compile transform so `stylex.create` never
  // reaches the runtime. The Rollup adapter supplies that transform without
  // installing Vite dev-server middleware that Vitest does not use.
  plugins: [stylex.rollup({ ...stylexOptions, dev: false })],
  test: {
    name: "ui",
    environment: "node",
  },
});

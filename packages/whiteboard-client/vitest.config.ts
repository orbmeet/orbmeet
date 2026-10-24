import viteReact from "@vitejs/plugin-react";
import stylex from "@stylexjs/unplugin";
import { defineConfig } from "vitest/config";

import { stylexOptions } from "../../stylex.config.ts";

export default defineConfig({
  plugins: [
    // Vitest needs StyleX's compile transform, but not its Vite dev-server
    // middleware. Keep it before React Compiler, matching the application.
    stylex.rollup({ ...stylexOptions, dev: false }),
    viteReact({
      compiler: {
        panicThreshold: "none",
        target: "19",
      },
    }),
  ],
  root: import.meta.dirname,
  test: {
    name: "whiteboard-client",
    environment: "node",
    include: ["src/**/*.test.{ts,tsx,js,mjs}"],
    setupFiles: ["./test/setup.ts"],
  },
  resolve: { tsconfigPaths: true },
});

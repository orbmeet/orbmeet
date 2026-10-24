import viteReact from "@vitejs/plugin-react";
import stylex from "@stylexjs/unplugin";
import { configDefaults, defineConfig } from "vitest/config";

import { stylexOptions } from "../../stylex.config.ts";

export default defineConfig({
  plugins: [
    // Vitest needs StyleX's compile transform, but not its Vite dev-server
    // middleware. Keep it before React Compiler, matching production.
    stylex.rollup({ ...stylexOptions, dev: false }),
    viteReact({
      compiler: {
        panicThreshold: "none",
        target: "19",
      },
    }),
  ],
  test: {
    name: "web",
    environment: "node",
    // e2e/ holds the Playwright smoke tests (`pnpm e2e`).
    exclude: [...configDefaults.exclude, "**/*.d1.test.{ts,tsx}", "e2e/**"],
  },
  root: import.meta.dirname,
  resolve: {
    tsconfigPaths: true,
    alias: {
      "cloudflare:workers": new URL("./src/test/cloudflare-workers-stub.ts", import.meta.url).pathname,
    },
  },
});

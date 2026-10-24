import { describe, expect, it } from "vitest";
import {
  dependencyNameFromModuleId,
  forbiddenWorkerDependencyReason,
} from "./worker-module-guard";

describe("workerModuleGuard", () => {
  it("extracts package names from pnpm and flat module paths", () => {
    expect(dependencyNameFromModuleId(
      "/repo/node_modules/.pnpm/@base-ui+react@1.7.0/node_modules/@base-ui/react/index.js",
    )).toBe("@base-ui/react");
    expect(dependencyNameFromModuleId("C:\\repo\\node_modules\\react-markdown\\index.js?x=1"))
      .toBe("react-markdown");
  });

  it("rejects browser runtime dependencies and permits SSR-capable UI", () => {
    expect(forbiddenWorkerDependencyReason("/repo/node_modules/livekit-client/dist/index.js")).toContain("browser entry");
    expect(forbiddenWorkerDependencyReason("/repo/node_modules/tldraw/dist/index.js")).toContain("browser entry");
    expect(forbiddenWorkerDependencyReason("/repo/node_modules/@base-ui/react/index.js")).toBeUndefined();
  });

  it("allows server dependencies with similar names", () => {
    expect(forbiddenWorkerDependencyReason(
      "/repo/node_modules/.pnpm/@tanstack+ai@0.31/node_modules/@tanstack/ai/index.js",
    )).toBeUndefined();
    expect(forbiddenWorkerDependencyReason(
      "/repo/node_modules/.pnpm/@simplewebauthn+server@13/node_modules/@simplewebauthn/server/index.js",
    )).toBeUndefined();
  });
});

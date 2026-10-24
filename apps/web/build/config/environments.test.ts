import { describe, expect, it } from "vitest";
import { createBuildEnvironments } from "./environments.ts";

describe("Vite build environments", () => {
  it("leaves both environments on Vite's default build target", () => {
    const environments = createBuildEnvironments(false);

    expect(environments.ssr.build).toEqual({ minify: "oxc", sourcemap: true });
    expect(environments.client.build).not.toHaveProperty("target");
    expect(environments.ssr.build).not.toHaveProperty("target");
  });

  it("keeps analysis builds readable without changing client chunk policy", () => {
    const environments = createBuildEnvironments(true);

    expect(environments.ssr.build.minify).toBe(false);
    expect(environments.client.build.rolldownOptions.output.codeSplitting.minSize).toBe(
      10_000,
    );
  });

  it("groups whiteboard dependencies by surface", () => {
    const groups = createBuildEnvironments(false).client.build
      .rolldownOptions.output.codeSplitting.groups;
    const surfaceGroup = groups.find((group) => group.name === "vendor-surface-core");
    const whiteboardGroup = groups.find((group) => group.name === "vendor-whiteboard-core");

    expect(surfaceGroup?.test).toBeTypeOf("function");
    expect(whiteboardGroup?.test).toBeTypeOf("function");
    if (typeof surfaceGroup?.test !== "function" || typeof whiteboardGroup?.test !== "function") {
      throw new Error("Whiteboard build groups must use classifier functions");
    }

    expect(surfaceGroup.test("/node_modules/rbush/index.js")).toBe(true);
    expect(whiteboardGroup.test("/node_modules/tldraw/index.js")).toBe(true);
  });
});

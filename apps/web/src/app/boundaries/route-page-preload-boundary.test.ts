import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The router warms a route by calling its component's `preload`. Left to itself
 * the route plugin moves `component` into a chunk of its own, so that call loads
 * only the small chunk holding the page's lazy wrapper and the page itself
 * stays cold until the click. A route with a `lazyRouteComponent` page therefore
 * keeps `component` out of its split groups.
 */
const routesDir = fileURLToPath(new URL("../../routes", import.meta.url));

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("routes with a preloadable page", () => {
  const pages = routeFiles(routesDir)
    .map((path) => ({ name: relative(routesDir, path), source: readFileSync(path, "utf8") }))
    .filter(({ source }) => /=\s*import\.meta\.env\.SSR \? \(\) => null : lazyRouteComponent\(/.test(source));

  it("finds them", () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it.each(pages)("$name keeps component out of the split", ({ source }) => {
    const groupings = source.match(/codeSplitGroupings:\s*(\[.*\]),/)?.[1];
    expect(groupings).toBeDefined();
    expect(groupings).not.toContain('"component"');
  });
});

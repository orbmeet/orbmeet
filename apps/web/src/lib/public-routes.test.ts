import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  isPublicDocumentPath,
  normalizeDocumentPath,
  publicDocumentPaths,
} from "./public-routes";

const routesDir = fileURLToPath(new URL("../routes", import.meta.url));

function collectRouteIds(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return collectRouteIds(join(dir, entry.name), `${prefix}/${entry.name}`);
    }
    if (!entry.isFile() || !entry.name.endsWith(".tsx")) return [];
    const base = entry.name.replace(/\.tsx$/, "");
    return [`${prefix}/${base}`];
  });
}

describe("public document allowlist", () => {
  // The shared-cache boundary is only as good as this enumeration. The previous
  // implementation listed authenticated prefixes instead, and drifted: it had
  // never been updated for the Whiteboard or Space routes, both of which were
  // consequently eligible for the shared public HTML cache.
  it("names an existing route for every page the build prerenders", () => {
    // The generated route tree lists every document path the router serves.
    const routeTree = readFileSync(new URL("../routeTree.gen.ts", import.meta.url), "utf8");
    const routedPaths = routeTree.slice(routeTree.indexOf("interface FileRoutesByFullPath"));
    for (const path of publicDocumentPaths()) {
      expect(routedPaths, `${path} must be a route`).toContain(`'${path}':`);
    }
  });

  it("treats every authenticated route as private", () => {
    const authedRouteIds = collectRouteIds(routesDir).filter((routeId) =>
      routeId.startsWith("/_authed"),
    );

    expect(authedRouteIds.length).toBeGreaterThan(0);
    for (const routeId of authedRouteIds) {
      // `/_authed/meetings/index` addresses the document `/meetings`.
      const pathname = routeId.replace(/^\/_authed/, "").replace(/\/index$/, "") || "/home";
      expect(isPublicDocumentPath(pathname)).toBe(false);
    }
  });

  it("keeps known private surfaces out of the allowlist", () => {
    for (const pathname of [
      "/home",
      "/meetings",
      "/meetings/mtg_123",
      "/spaces",
      "/space/engineering",
      "/whiteboards",
      "/whiteboards/wb_123",
      "/settings",
      "/auth",
      "/verify",
      "/recorder",
      "/handoff/mtg_123",
      "/join/abcdefgh",
      "/abc-defg-hij",
      "/some-route-added-later",
    ]) {
      expect(isPublicDocumentPath(pathname)).toBe(false);
    }
  });

  it("accepts the public pages with or without a trailing slash", () => {
    for (const pathname of ["/", "/pricing", "/privacy", "/refund", "/status", "/terms"]) {
      expect(isPublicDocumentPath(pathname)).toBe(true);
      expect(isPublicDocumentPath(`${pathname}/`)).toBe(true);
    }
  });

  it("normalizes trailing slashes without emptying the root path", () => {
    expect(normalizeDocumentPath("/")).toBe("/");
    expect(normalizeDocumentPath("/pricing/")).toBe("/pricing");
    expect(normalizeDocumentPath("/pricing")).toBe("/pricing");
  });
});

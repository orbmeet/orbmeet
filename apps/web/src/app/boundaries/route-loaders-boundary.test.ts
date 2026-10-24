import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  Visitor,
  type Argument,
  type CallExpression,
  type Expression,
  type ObjectExpression,
  type ObjectProperty,
} from "oxc-parser";
import { parseSource } from "../../../build/source-analysis/parse-source";

/**
 * The router is created with `defaultPreloadStaleTime: 0` so that TanStack Query
 * — not the router's own match cache — decides whether loader data is still
 * fresh (see `src/router.tsx` and the Router preloading guide). That delegation
 * only holds while every loader actually goes through the QueryClient: a loader
 * that calls a server function directly re-runs on *every* intent preload,
 * including repeat hovers of a link that was already preloaded, because
 * `staleAge` is 0 and a preloaded match's cause is always `enter`.
 *
 * So a route may call a server function straight from its loader only when it
 * has explicitly opted out of preloading.
 */
const routesDir = fileURLToPath(new URL("../../routes", import.meta.url));
const webRoot = fileURLToPath(new URL("../../", import.meta.url));

function collectRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return collectRouteFiles(fullPath);
    if (!entry.isFile() || !entry.name.endsWith(".tsx")) return [];
    return [fullPath];
  });
}

function isCallExpression(node: Expression): node is CallExpression {
  return node.type === "CallExpression";
}

function isObjectExpression(node: Argument | undefined): node is ObjectExpression {
  return node?.type === "ObjectExpression";
}

function isObjectProperty(
  property: ObjectExpression["properties"][number],
): property is ObjectProperty {
  return property.type === "Property";
}

function propertyName(property: ObjectProperty): string | undefined {
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal" && typeof property.key.value === "string") {
    return property.key.value;
  }
  return undefined;
}

interface RouteOptions {
  loaderSource?: string;
  preloadDisabled: boolean;
  serverFnLocalNames: string[];
}

/** Local binding names this module imports from a server-function module. */
function collectServerFnLocalNames(parsed: ReturnType<typeof parseSource>): string[] {
  return parsed.module.staticImports.flatMap((staticImport) => {
    const specifier = staticImport.moduleRequest.value;
    const isServerModule =
      specifier.startsWith("@/server/") ||
      specifier.includes("/server/") ||
      specifier.endsWith("/server") ||
      specifier.includes(".server");
    if (!isServerModule) return [];
    return staticImport.entries
      .filter((entry) => !entry.isType)
      .map((entry) => entry.localName.value);
  });
}

function parseRouteOptions(filePath: string, source: string): RouteOptions | undefined {
  const parsed = parseSource(filePath, source);
  const program = parsed.program;
  const serverFnLocalNames = collectServerFnLocalNames(parsed);
  let options: RouteOptions | undefined;

  new Visitor({
    CallExpression(node) {
      if (options || !isCallExpression(node.callee)) return;
      const callee = node.callee.callee;
      if (callee.type !== "Identifier" || callee.name !== "createFileRoute") return;

      const optionsArg = node.arguments[0];
      if (!isObjectExpression(optionsArg)) return;

      let loaderSource: string | undefined;
      let preloadDisabled = false;

      for (const property of optionsArg.properties) {
        if (!isObjectProperty(property)) continue;
        const name = propertyName(property);
        if (name === "loader") {
          loaderSource = source.slice(property.value.start, property.value.end);
        } else if (
          name === "preload" &&
          property.value.type === "Literal" &&
          property.value.value === false
        ) {
          preloadDisabled = true;
        }
      }

      options = { loaderSource, preloadDisabled, serverFnLocalNames };
    },
  }).visit(program);

  return options;
}

function referencedNames(loaderSource: string, names: string[]): string[] {
  return names.filter((name) =>
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(loaderSource),
  );
}

describe("route loaders and preloading", () => {
  const routeFiles = collectRouteFiles(routesDir).filter(
    (path) => !path.includes(".test."),
  );

  it("finds the route modules it is meant to guard", () => {
    expect(routeFiles.length).toBeGreaterThan(10);
  });

  it("routes every preloadable loader through the QueryClient", () => {
    const violations: string[] = [];

    for (const filePath of routeFiles) {
      const options = parseRouteOptions(filePath, readFileSync(filePath, "utf8"));
      if (!options?.loaderSource) continue;
      if (options.preloadDisabled) continue;

      const direct = referencedNames(options.loaderSource, options.serverFnLocalNames);
      if (direct.length === 0) continue;

      violations.push(
        `${relative(webRoot, filePath)}: loader calls ${direct.join(", ")} directly ` +
          "instead of through context.queryClient. Wrap the request in queryOptions " +
          "and use fetchQuery/prefetchQuery, or set `preload: false` on the " +
          "route if entry must always re-fetch.",
      );
    }

    expect(violations).toEqual([]);
  });

  it("lets Query freshness govern blocking loader reads", () => {
    const violations: string[] = [];

    for (const filePath of routeFiles) {
      const options = parseRouteOptions(filePath, readFileSync(filePath, "utf8"));
      if (!options?.loaderSource) continue;
      if (!options.loaderSource.includes(".ensureQueryData(")) continue;
      violations.push(
        `${relative(webRoot, filePath)}: ensureQueryData returns cached data even when `
          + "stale or invalidated; use fetchQuery for blocking loader reads",
      );
    }

    expect(violations).toEqual([]);
  });

  it("detects a loader that reaches a server function directly", () => {
    const options = parseRouteOptions(
      "probe.tsx",
      [
        `import { createFileRoute } from "@tanstack/react-router";`,
        `import { getThing } from "@/server/things";`,
        `export const Route = createFileRoute("/probe")({`,
        `  loader: () => getThing({ data: {} }),`,
        `});`,
      ].join("\n"),
    );

    expect(options?.preloadDisabled).toBe(false);
    expect(referencedNames(options!.loaderSource!, options!.serverFnLocalNames)).toEqual([
      "getThing",
    ]);
  });

  it("recognizes the modules/*/server convention used by application routes", () => {
    const options = parseRouteOptions(
      "probe.tsx",
      [
        `import { createFileRoute } from "@tanstack/react-router";`,
        `import { getThing } from "@/modules/things/server/read";`,
        `export const Route = createFileRoute("/probe")({`,
        `  loader: () => getThing({ data: {} }),`,
        `});`,
      ].join("\n"),
    );

    expect(referencedNames(options!.loaderSource!, options!.serverFnLocalNames)).toEqual([
      "getThing",
    ]);
  });
});

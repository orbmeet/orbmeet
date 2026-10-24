import { readFileSync } from "node:fs";
import { parseFile, parseSource } from "./parse-source";

export function getRuntimeStaticImports(path: string): string[] {
  return parseFile(path).module.staticImports
    .filter((staticImport) =>
      staticImport.entries.length === 0 ||
      staticImport.entries.some((entry) => !entry.isType),
    )
    .map((staticImport) => staticImport.moduleRequest.value);
}

/** Every static import, type-only ones included. */
export function getStaticImports(path: string): string[] {
  return parseFile(path).module.staticImports.map((staticImport) => staticImport.moduleRequest.value);
}

export function getRuntimeStaticReexports(path: string): string[] {
  return parseFile(path).module.staticExports.flatMap((staticExport) =>
    staticExport.entries.flatMap((entry) =>
      !entry.isType && entry.moduleRequest ? [entry.moduleRequest.value] : [],
    ),
  );
}

export function getRuntimeDynamicImports(path: string): string[] {
  const source = readFileSync(path, "utf8");
  return parseSource(path, source).module.dynamicImports.flatMap((dynamicImport) => {
    const { start, end } = dynamicImport.moduleRequest;
    const literal = source.slice(start, end);
    const quote = literal[0];
    if ((quote !== '"' && quote !== "'" && quote !== "`") || literal.at(-1) !== quote) return [];
    const specifier = literal.slice(1, -1);
    return specifier.includes("\\") || specifier.includes("${") ? [] : [specifier];
  });
}

import { readFileSync } from "node:fs";
import { type ParseResult, parseSync } from "oxc-parser";

// Parse TS/TSX with oxc-parser — the same engine that powers oxlint — rather
// than the TypeScript compiler API. TypeScript 7 moved its AST surface
// (`ts.createSourceFile`, the `ts.isXxx` guards, `SyntaxKind`, ...) out of the
// bare `typescript` import and into the explicitly-unstable, process-spawning
// `typescript/unstable/*` entrypoint, so it is no longer a stable way to turn
// source text into a walkable AST. oxc-parser returns a standard ESTree AST plus
// a module record, and auto-detects the dialect (JS/JSX/TS/TSX) from the file
// extension, so JSX needs no extra configuration.
export function parseSource(path: string, source: string): ParseResult {
  const result = parseSync(path, source);

  const errors = result.errors.filter((error) => error.severity === "Error");
  if (errors.length > 0) {
    throw new Error(
      `Failed to parse ${path}:\n${errors.map((error) => error.message).join("\n")}`,
    );
  }

  return result;
}

export function parseFile(path: string): ParseResult {
  return parseSource(path, readFileSync(path, "utf8"));
}

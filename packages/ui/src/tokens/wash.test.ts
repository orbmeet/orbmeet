import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { accent, ink, surface } from "./colors.stylex";
import { glass, inkWash, scrim, scrimBase } from "./wash.stylex";

const source = readFileSync(new URL("./wash.stylex.ts", import.meta.url), "utf8");

function definitionOf(name: string): string {
  const start = source.indexOf(`export const ${name} = stylex.defineVars({`);
  expect(start, `${name} definition`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n});", start);
  expect(end, `${name} definition terminator`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * The point of this token layer is that a translucent colour tracks the opaque
 * one it was mixed from. That is exactly what the hand-typed `rgba()` literals
 * it replaced could not do: they were the *value* of a token, copied, so a
 * palette change moved the opaque sites and left every translucent one behind
 * — silently, with nothing failing. Subtree themes are a separate cascade
 * concern documented in `wash.stylex.ts`.
 *
 * These assertions are deliberately about the *shape* of the compiled output
 * rather than a resolved colour. StyleX compiles a var reference to
 * `var(--hash)` and the browser resolves the mix; a test that could see a
 * final rgb value would be testing the browser, not the contract.
 */
describe("wash tokens", () => {
  it("compile every wash to a variable reference", () => {
    for (const token of [scrim.backdrop, glass.panel, inkWash.x06, scrimBase.black]) {
      expect(token).toMatch(/^var\(--[\w-]+\)$/);
    }
  });

  it("gives each wash its own variable", () => {
    const ramp = [scrim.hairline, scrim.edge, scrim.soft, scrim.wash, scrim.backdrop, scrim.strong, scrim.heavy];
    expect(new Set(ramp).size).toBe(ramp.length);
  });

  it("derives every ramp stop from its named base token", () => {
    // Runtime imports only expose each compiled var(--hash), not the expression
    // assigned to it. Pin the source relationship as well, so replacing one
    // stop with an rgba literal cannot leave this test green.
    expect(definitionOf("scrim").match(/\$\{scrimBase\.black\}/g)).toHaveLength(7);
    expect(definitionOf("glass").match(/\$\{surface\.raised\}/g)).toHaveLength(5);
    expect(definitionOf("inkWash").match(/\$\{ink\.shadow\}/g)).toHaveLength(6);

    for (const base of [surface.raised, ink.strong, accent.a500]) {
      expect(base).toMatch(/^var\(--[\w-]+\)$/);
    }
  });
});

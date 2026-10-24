import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Resolve from the workspace root: apps/web intentionally maps its local
// `typescript` dependency to the native preview, which exposes no parser API.
const ts = createRequire(new URL("../../../package.json", import.meta.url))(
  "typescript",
);

const WEB_ROOT = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[jt]sx$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Strip comments before matching. Both halves of the marker contract get
 * explained in prose right next to the code, and a docblock saying
 * "defaultMarker() is load-bearing here" must not be able to satisfy the check
 * that the call is actually present.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** As `sourceFiles`, but including plain `.ts` — style modules are not JSX. */
function styleSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return styleSourceFiles(path);
    if (/\.test\.[jt]sx?$/.test(entry.name)) return [];
    return /\.[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

const STYLE_SOURCE_ROOTS = [
  WEB_ROOT,
  resolve(REPO_ROOT, "packages/ui/src"),
  resolve(REPO_ROOT, "packages/whiteboard-client/src"),
];

function sourceFile(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

describe("StyleX migration", () => {
  it("keeps Tailwind out of the application toolchain", () => {
    const manifest = readFileSync(resolve(REPO_ROOT, "apps/web/package.json"), "utf8");
    const viteConfig = readFileSync(resolve(REPO_ROOT, "apps/web/vite.config.ts"), "utf8");
    const cssEntry = readFileSync(resolve(WEB_ROOT, "styles.css"), "utf8");

    expect(manifest).not.toContain("tailwindcss");
    expect(viteConfig).not.toContain("tailwindcss");
    expect(cssEntry).not.toMatch(/@(?:source|theme|utility)\b/);
  });

  it("does not reintroduce utility class strings into app or UI markup", () => {
    const allowedIntegrationFiles = new Set([
      resolve(WEB_ROOT, "styles.contract.test.ts"),
      resolve(WEB_ROOT, "modules/whiteboards/client/surface/whiteboard-canvas.tsx"),
    ]);
    const sources = [
      ...sourceFiles(WEB_ROOT),
      ...sourceFiles(resolve(REPO_ROOT, "packages/ui/src")),
    ].filter((path) => !allowedIntegrationFiles.has(path));

    const offenders = sources.filter((path) =>
      /\bclassName\s*=/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * `stylex.when.*` compiles to `:where(.<marker>:state *)` — a selector that
   * matches nothing unless some ancestor carries a StyleX marker class. Drop
   * the marker and the rule does not error, does not warn, and never applies;
   * the style is simply gone. That is exactly how a batch of `group-hover:`
   * conversions lost their hover states in this migration.
   *
   * A file-level pairing check is coarse — it cannot prove the marker sits on
   * the *right* ancestor — but it catches the failure that actually happened:
   * the marker being nowhere at all.
   */
  it("pairs every contextual selector with a marker", () => {
    const sources = [
      ...styleSourceFiles(WEB_ROOT),
      ...styleSourceFiles(resolve(REPO_ROOT, "packages/ui/src")),
      ...styleSourceFiles(resolve(REPO_ROOT, "packages/whiteboard-client/src")),
    ];

    const unpaired = sources
      .map((path) => ({ path, source: withoutComments(readFileSync(path, "utf8")) }))
      .filter(({ source }) => /\bstylex\.when\./.test(source))
      // Either the default marker, or a named one from a `.stylex` module.
      .filter(({ source }) => !/defaultMarker\(|markers\.stylex/.test(source))
      .map(({ path }) => path.slice(REPO_ROOT.length));

    expect(unpaired).toEqual([]);
  });

  it("capability-gates every hover style", () => {
    const offenders: string[] = [];

    for (const path of STYLE_SOURCE_ROOTS.flatMap(styleSourceFiles)) {
      const source = sourceFile(path);

      function visit(node: any, inStylexCreate = false) {
        const isCreate = ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.getText(source) === "stylex" &&
          node.expression.name.text === "create";
        const insideCreate = inStylexCreate || isCreate;

        if (insideCreate && ts.isPropertyAssignment(node)) {
          const name = node.name;
          const isHover = (ts.isStringLiteral(name) && name.text.startsWith(":hover")) ||
            (ts.isComputedPropertyName(name) && /stylex\.when\.ancestor\(["']:hover/.test(name.expression.getText(source)));

          if (isHover) {
            let gated = false;
            for (let parent = node.parent; parent && parent !== source; parent = parent.parent) {
              if (
                ts.isPropertyAssignment(parent) &&
                ts.isComputedPropertyName(parent.name) &&
                parent.name.expression.getText(source) === "env.hoverable"
              ) {
                gated = true;
                break;
              }
              if (ts.isCallExpression(parent) && parent !== node && isCreate) break;
            }
            if (!gated) {
              const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
              offenders.push(`${path.slice(REPO_ROOT.length)}:${line}`);
            }
          }
        }

        ts.forEachChild(node, (child: any) => visit(child, insideCreate));
      }

      visit(source);
    }

    expect(offenders).toEqual([]);
  });

  /**
   * `stylex.props()` returns `{ className, style }`, and for a *dynamic* style
   * — `styles.width(320)`, `glow.orb(tint, 80)` — the `style` half is not
   * decoration: it carries the custom properties the generated class reads. A
   * JSX `style={{…}}` on the same element replaces that object wholesale, so
   * the class resolves against variables nobody ever set.
   *
   * Spreading StyleX first at least keeps the class, which is why the ordering
   * half of this rule exists. But ordering cannot save a dynamic style, so the
   * two cases are separated: a static `stylex.props()` may be followed by an
   * inline style, a dynamic one may not be combined with it at all. The escape
   * hatch, when an element genuinely needs both, is to merge by hand:
   *
   *     const props = stylex.props(styles.a, styles.sized(w));
   *     <div {...props} style={{ ...props.style, top }} />
   */
  it("never pairs a JSX inline style with a dynamic StyleX call", () => {
    const misordered: string[] = [];
    const clobbered: string[] = [];

    for (const path of STYLE_SOURCE_ROOTS.flatMap(sourceFiles)) {
      const source = sourceFile(path);

      function visit(node: any) {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const style = node.attributes.properties.find(
            (attribute: any) =>
              ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "style",
          );
          const stylexSpread = node.attributes.properties.find(
            (attribute: any) =>
              ts.isJsxSpreadAttribute(attribute) &&
              ts.isCallExpression(attribute.expression) &&
              attribute.expression.expression.getText(source) === "stylex.props",
          );

          if (style && stylexSpread) {
            const line = source.getLineAndCharacterOfPosition(style.getStart(source)).line + 1;
            const where = `${path.slice(REPO_ROOT.length)}:${line}`;

            // A dynamic style is an argument that is itself a call — the only
            // way `stylex.props` ends up contributing inline variables.
            const hasDynamicArgument = stylexSpread.expression.arguments.some(
              function isDynamic(argument: any): boolean {
                if (ts.isCallExpression(argument)) return true;
                if (ts.isBinaryExpression(argument)) return isDynamic(argument.right);
                if (ts.isConditionalExpression(argument)) {
                  return isDynamic(argument.whenTrue) || isDynamic(argument.whenFalse);
                }
                if (ts.isParenthesizedExpression(argument)) return isDynamic(argument.expression);
                if (ts.isArrayLiteralExpression(argument)) return argument.elements.some(isDynamic);
                return false;
              },
            );

            if (hasDynamicArgument) clobbered.push(where);
            else if (style.getStart(source) < stylexSpread.getStart(source)) misordered.push(where);
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(source);
    }

    expect(clobbered).toEqual([]);
    expect(misordered).toEqual([]);
  });

  /**
   * `rgba()` cannot take a custom property as its colour, so every translucent
   * surface in the app used to be a hand-typed literal: the rgb triple of a
   * token with an alpha stapled on. 461 of them across 80 files, and each one
   * was invisible to `createTheme` — re-tune `accent.a500` and 35 sites kept
   * the old blue, with no error and no failing test.
   *
   * `color-mix(in oklab, <token> N%, transparent)` is how a translucent colour
   * is written now, either inline or named in `tokens/wash.stylex.ts`. This
   * check is what stops the next one creeping back in.
   *
   * Only `.stylex.ts` files may hold a raw colour, because that is where the
   * palette's actual values have to live. Everything else names a token.
   */
  it("keeps raw colour literals out of style definitions", () => {
    const sources = [
      ...styleSourceFiles(WEB_ROOT),
      ...styleSourceFiles(resolve(REPO_ROOT, "packages/ui/src")),
      ...styleSourceFiles(resolve(REPO_ROOT, "packages/whiteboard-client/src")),
      // The palette itself, and any component-local token module, are where
      // real values are declared.
    ].filter((path) => !path.endsWith(".stylex.ts"));

    const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

    const offenders = sources.flatMap((path) => {
      const source = withoutComments(readFileSync(path, "utf8"));
      // Only look inside style definitions. A colour in a canvas-painting call
      // or a data fixture is not a style, and tokenising it would be wrong.
      const hits: string[] = [];
      let depth = 0;
      let inBlock = false;
      for (const [index, line] of source.split("\n").entries()) {
        if (!inBlock && /stylex\.(create|keyframes|createTheme)\s*\(/.test(line)) {
          inBlock = true;
          depth = 0;
        }
        if (!inBlock) continue;
        for (const character of line) {
          if (character === "(" || character === "{") depth += 1;
          else if (character === ")" || character === "}") depth -= 1;
        }
        if (COLOUR.test(line)) {
          hits.push(`${path.slice(REPO_ROOT.length)}:${index + 1}  ${line.trim()}`);
        }
        if (depth <= 0) inBlock = false;
      }
      return hits;
    });

    expect(offenders).toEqual([]);
  });

  it("keeps raw colour literals out of JSX inline style objects", () => {
    const offenders = new Set<string>();
    const mathShapeUtil = resolve(
      REPO_ROOT,
      "packages/whiteboard-client/src/shapes/math/math-shape-util.tsx",
    );
    const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

    for (const path of STYLE_SOURCE_ROOTS.flatMap(sourceFiles)) {
      const source = sourceFile(path);

      function visit(node: any) {
        if (
          ts.isJsxAttribute(node) &&
          node.name.getText(source) === "style" &&
          node.initializer &&
          ts.isJsxExpression(node.initializer) &&
          node.initializer.expression
        ) {
          const expression = node.initializer.expression;
          function findLiteral(candidate: any) {
            if (
              (ts.isStringLiteral(candidate) ||
                ts.isNoSubstitutionTemplateLiteral(candidate) ||
                ts.isTemplateExpression(candidate)) &&
              COLOUR.test(candidate.getText(source))
            ) {
              const line = source.getLineAndCharacterOfPosition(candidate.getStart(source)).line + 1;
              // A standalone SVG export cannot carry live StyleX variables.
              let insideMathExport = false;
              if (path === mathShapeUtil) {
                for (let parent = candidate.parent; parent; parent = parent.parent) {
                  if (
                    ts.isFunctionDeclaration(parent) &&
                    parent.name?.text === "renderMathSvg"
                  ) {
                    insideMathExport = true;
                    break;
                  }
                }
              }
              if (!insideMathExport) {
                offenders.add(`${path.slice(REPO_ROOT.length)}:${line}`);
              }
            }
            ts.forEachChild(candidate, findLiteral);
          }
          findLiteral(expression);
          return;
        }
        ts.forEachChild(node, visit);
      }

      visit(source);
    }

    expect([...offenders].sort()).toEqual([]);
  });

  it("keeps app-owned component selectors out of the global CSS entry", () => {
    const cssEntry = readFileSync(resolve(WEB_ROOT, "styles.css"), "utf8");
    expect(cssEntry).not.toContain("components.css");
    expect(cssEntry).not.toMatch(/\.(?:surface|liquid-|bento-|cine-)/);
  });

  /**
   * `@stylexjs/no-unused` is enabled, but it reasons one file at a time, so an
   * *exported* style namespace is exempt by construction — nothing in the
   * toolchain can see that no other file ever reaches for it. That blind spot
   * had accumulated five dead namespaces and two dozen dead keys, every one of
   * which StyleX still compiled into the shipped sheet.
   *
   * Resolution has to follow import aliases: `import { type as typeStyles }`
   * is how `atoms.type` stayed alive while a name-only sweep called it dead.
   */
  it("has no exported style namespace or key without a consumer", () => {
    /**
     * Deliberate exceptions — sets whose completeness *is* the API, where a
     * hole would be the defect. Add to this list only with a reason.
     */
    const ALLOWED_UNUSED = new Set([
      // One name per edge, so it is not possible to pad the bottom with the
      // top inset. Dropping the unused edges would reintroduce exactly the
      // mispairing the namespace exists to prevent.
      "safe.padLeft", "safe.padY", "safe.padAll", "safe.inset", "safe.top", "safe.bottom",
      // The three drifting orbs are one ordered set; the meeting mounts orb1
      // today and the trio is what the scene is composed from.
      "ambient.orb2", "ambient.orb3", "ambient.blob",
    ]);

    const sources = STYLE_SOURCE_ROOTS.flatMap(styleSourceFiles);

    // 1. Every exported `stylex.create` namespace and the keys it declares.
    const declared: Array<{ ns: string; keys: string[]; path: string }> = [];
    for (const path of sources) {
      const source = sourceFile(path);
      function visit(node: any) {
        if (
          ts.isVariableDeclaration(node) &&
          node.initializer &&
          ts.isCallExpression(node.initializer) &&
          node.initializer.expression.getText(source) === "stylex.create" &&
          node.parent?.parent &&
          ts.isVariableStatement(node.parent.parent) &&
          node.parent.parent.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          const argument = node.initializer.arguments[0];
          if (argument && ts.isObjectLiteralExpression(argument)) {
            declared.push({
              ns: node.name.getText(source),
              path,
              keys: argument.properties
                .filter(ts.isPropertyAssignment)
                .map((p: any) => p.name.getText(source).replace(/^["']|["']$/g, "")),
            });
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }

    // 2. Every `<binding>.<key>` reach, with `binding` mapped back through any
    //    import alias to the name the namespace was exported under.
    const used = new Set<string>();
    const reachedDynamically = new Set<string>();
    for (const path of sources) {
      const source = sourceFile(path);
      const alias = new Map<string, string>();
      function collectAliases(node: any) {
        if (
          ts.isImportDeclaration(node) &&
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings)
        ) {
          for (const element of node.importClause.namedBindings.elements) {
            alias.set(element.name.text, (element.propertyName ?? element.name).text);
          }
        }
        ts.forEachChild(node, collectAliases);
      }
      collectAliases(source);

      const declaredHere = new Set(declared.filter((d) => d.path === path).map((d) => d.ns));
      const resolve_ = (local: string) =>
        alias.get(local) ?? (declaredHere.has(local) ? local : null);

      function collectUses(node: any) {
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
          const ns = resolve_(node.expression.text);
          if (ns) used.add(`${ns}.${node.name.text}`);
        }
        // `eq[index]` / `fills[variant]` — the key is not statically known, so
        // the whole namespace has to count as reached.
        if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
          const ns = resolve_(node.expression.text);
          if (ns) reachedDynamically.add(ns);
        }
        ts.forEachChild(node, collectUses);
      }
      collectUses(source);
    }

    const orphans = declared
      .filter((d) => !reachedDynamically.has(d.ns))
      .flatMap((d) =>
        d.keys
          .map((key) => `${d.ns}.${key}`)
          .filter((id) => !used.has(id) && !ALLOWED_UNUSED.has(id))
          .map((id) => `${d.path.slice(REPO_ROOT.length)}  ${id}`),
      );

    expect(orphans).toEqual([]);
  });

  /**
   * The whiteboard desk is `surface.board`, and both board wrappers publish it
   * as `--wb-document-bg` so the focus mask and `whiteboard-canvas.css` can
   * read it without a class. The stylesheet still needs a literal fallback
   * because a static `.css` file cannot name a hashed StyleX variable — this is
   * the only copy of that colour left, and this is what keeps it honest.
   */
  it("keeps the whiteboard stylesheet's desk fallback on the token's value", () => {
    const tokens = readFileSync(
      resolve(REPO_ROOT, "packages/ui/src/tokens/colors.stylex.ts"),
      "utf8",
    );
    const board = /^\s*board:\s*"(#[0-9a-fA-F]{3,8})"/m.exec(tokens)?.[1];
    expect(board).toBeDefined();

    const stylesheet = readFileSync(
      resolve(REPO_ROOT, "packages/whiteboard-client/src/whiteboard-canvas.css"),
      "utf8",
    );
    const fallbacks = [...stylesheet.matchAll(/var\(--wb-document-bg,\s*([^)]+)\)/g)]
      .map((match) => match[1].trim().toLowerCase());

    expect(fallbacks.length).toBeGreaterThan(0);
    for (const fallback of fallbacks) expect(fallback).toBe(board?.toLowerCase());
  });

  /**
   * tldraw cancels touches near the window edge and then clicks the target
   * itself — but only when that target is a BUTTON. The tool palette sits at
   * the left edge, so a finger on a tool's icon was swallowed and switching
   * tools worked only some of the time. Keeping every button's descendants
   * out of hit-testing is what makes the button the target, every time.
   */
  it("keeps the board's button icons out of touch hit-testing", () => {
    const stylesheet = readFileSync(
      resolve(REPO_ROOT, "packages/whiteboard-client/src/whiteboard-canvas.css"),
      "utf8",
    );
    expect(stylesheet).toMatch(/\.whiteboard-document button \*\s*\{\s*pointer-events:\s*none;\s*\}/);
  });
});

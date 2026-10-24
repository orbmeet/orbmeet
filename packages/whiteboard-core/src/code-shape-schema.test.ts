import { describe, expect, it } from "vitest";
import {
  CODE_LANGUAGES,
  CODE_SHAPE_MIGRATIONS,
  CODE_SHAPE_PROPS,
  CODE_SHAPE_TYPE,
  createCodeShapeProps,
  DEFAULT_CODE_HEIGHT,
  DEFAULT_CODE_WIDTH,
  getStarterCode,
  isStarterCode,
  MAX_CODE_CHARS,
  MAX_CODE_HEIGHT,
  MAX_CODE_OUTPUT_CHARS,
  MAX_CODE_WIDTH,
  MIN_CODE_HEIGHT,
  MIN_CODE_WIDTH,
} from "./code-shape-schema.ts";
import { whiteboardTLSchema } from "./room-schema.ts";

const runInitialMigration = (props: Record<string, unknown>) => {
  const migration = CODE_SHAPE_MIGRATIONS.sequence[0] as {
    up: (props: Record<string, unknown>) => void;
  };
  migration.up(props);
  return props;
};

const runRetireJsonMigration = (props: Record<string, unknown>) => {
  const migration = CODE_SHAPE_MIGRATIONS.sequence[1] as {
    up: (props: Record<string, unknown>) => void;
  };
  migration.up(props);
  return props;
};

describe("code shape props", () => {
  it("starts a new cell in an idle, empty-output state", () => {
    const props = createCodeShapeProps();

    expect(props.w).toBe(DEFAULT_CODE_WIDTH);
    expect(props.h).toBe(DEFAULT_CODE_HEIGHT);
    expect(props.language).toBe("javascript");
    expect(props.status).toBe("idle");
    expect(props.output).toBe("");
    expect(props.code).toBe(getStarterCode("javascript"));
  });

  it("carries the picked language's starter snippet", () => {
    expect(createCodeShapeProps({ language: "rust" }).code).toBe(getStarterCode("rust"));
  });

  it("gives every language a starter that is a complete program", () => {
    // A cell's first Run happens before anyone edits the starter, so a snippet
    // that does not compile as-is makes the language look broken.
    const empty = CODE_LANGUAGES.filter((language) => !getStarterCode(language).trim());
    expect(empty).toEqual([]);
    // javac takes the class name from the file, and the runner writes Main.java.
    expect(getStarterCode("java")).toContain("class Main");
    expect(getStarterCode("go")).toContain("package main");
  });

  it("recognizes untouched starter code for every language", () => {
    for (const language of CODE_LANGUAGES) {
      expect(isStarterCode(getStarterCode(language))).toBe(true);
    }
    expect(isStarterCode("console.log('mine')")).toBe(false);
  });

  it("validates a created shape against the room schema", () => {
    // The room schema is what the sync server enforces, so a shape the client
    // can build but the schema rejects would only fail once it left the tab.
    const record = whiteboardTLSchema.types.shape.create({
      type: CODE_SHAPE_TYPE,
      props: createCodeShapeProps({ language: "python", code: "print(1)" }),
    });

    expect(record.typeName).toBe("shape");
  });
});

describe("code shape validators", () => {
  it("bounds width and height independently", () => {
    expect(() => CODE_SHAPE_PROPS.w.validate(MIN_CODE_WIDTH - 1)).toThrow();
    expect(() => CODE_SHAPE_PROPS.h.validate(MIN_CODE_HEIGHT - 1)).toThrow();
    expect(() => CODE_SHAPE_PROPS.w.validate(MAX_CODE_WIDTH + 1)).toThrow();
    expect(() => CODE_SHAPE_PROPS.h.validate(MAX_CODE_HEIGHT + 1)).toThrow();

    // MIN_CODE_HEIGHT is below MIN_CODE_WIDTH, so a shared bound would have
    // rejected legal heights.
    expect(() => CODE_SHAPE_PROPS.h.validate(MIN_CODE_HEIGHT)).not.toThrow();
  });

  it("rejects source and output past their caps", () => {
    expect(() => CODE_SHAPE_PROPS.code.validate("x".repeat(MAX_CODE_CHARS + 1))).toThrow();
    expect(() =>
      CODE_SHAPE_PROPS.output.validate("x".repeat(MAX_CODE_OUTPUT_CHARS + 1)),
    ).toThrow();
  });

  it("accepts every language the runner has a toolchain for", () => {
    const rejected = CODE_LANGUAGES.filter((language) => {
      try {
        CODE_SHAPE_PROPS.language.validate(language);
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toEqual([]);
  });

  it("rejects a language with no runner behind it", () => {
    // `json` was browser-side pretty-printing, never execution, and has no
    // toolchain in the runner's image.
    expect(() => CODE_SHAPE_PROPS.language.validate("json")).toThrow();
    expect(() => CODE_SHAPE_PROPS.language.validate("ruby")).toThrow();
  });

  it("rejects a synced running status", () => {
    expect(() => CODE_SHAPE_PROPS.status.validate("running")).toThrow();
  });
});

describe("code shape migration", () => {
  it("clamps malformed props instead of failing the record", () => {
    const migrated = runInitialMigration({
      w: -50,
      h: 999_999,
      code: "x".repeat(MAX_CODE_CHARS + 100),
      output: "y".repeat(MAX_CODE_OUTPUT_CHARS + 50),
      language: "brainfuck",
      status: "confused",
      executionTimeMs: -10,
    });

    expect(migrated.w).toBe(MIN_CODE_WIDTH);
    expect(migrated.h).toBe(MAX_CODE_HEIGHT);
    expect((migrated.code as string).length).toBe(MAX_CODE_CHARS);
    expect((migrated.output as string).length).toBe(MAX_CODE_OUTPUT_CHARS);
    expect(migrated.language).toBe("javascript");
    expect(migrated.status).toBe("idle");
    expect(migrated.executionTimeMs).toBe(0);
  });

  it("folds a language with no toolchain onto one that exists", () => {
    expect(runInitialMigration({ language: "json" }).language).toBe("javascript");
    expect(runInitialMigration({ language: "brainfuck" }).language).toBe("javascript");
  });

  it("keeps a language the runner has since gained", () => {
    // These two were flattened to JavaScript when nothing could execute them.
    // Now that the runner can, a board that still carries one is honoured.
    expect(runInitialMigration({ language: "python" }).language).toBe("python");
    expect(runInitialMigration({ language: "typescript" }).language).toBe("typescript");
  });

  it("retires json for records that already passed the first migration", () => {
    // A record stopped at version 1 never re-runs `Initial`, so without this
    // step its `json` language would reach the validator and be rejected —
    // taking the whole room snapshot down with it.
    expect(runRetireJsonMigration({ language: "json" }).language).toBe("javascript");
    expect(runRetireJsonMigration({ language: "rust" }).language).toBe("rust");
  });

  it("keeps a retired cell's source so it is recoverable", () => {
    const migrated = runRetireJsonMigration({ language: "json", code: '{"a":1}' });
    expect(migrated.code).toBe('{"a":1}');
  });

  it("recovers a board saved mid-run", () => {
    // Without this, a cell whose author closed their tab would show "Running…"
    // to everyone, forever, with nothing left alive to clear it.
    expect(runInitialMigration({ status: "running" }).status).toBe("idle");
  });

  it("drops the abandoned lock field", () => {
    expect(runInitialMigration({ lockedBy: "someone" })).not.toHaveProperty("lockedBy");
  });

  it("produces props the validators accept", () => {
    const migrated = runInitialMigration({ w: "wide", h: null, code: 42, status: "running" });

    const rejected = Object.entries(CODE_SHAPE_PROPS)
      .filter(([key, validator]) => {
        try {
          validator.validate(migrated[key]);
          return false;
        } catch {
          return true;
        }
      })
      .map(([key]) => key);

    expect(rejected).toEqual([]);
  });
});

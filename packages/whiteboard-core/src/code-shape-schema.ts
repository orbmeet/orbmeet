import { clampFinite } from "@orbmeet/primitives";
import {
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  type TLShape,
} from "@tldraw/tlschema";
import { T } from "@tldraw/validate";

export const CODE_SHAPE_TYPE = "code" as const;

/**
 * A new cell's box. Sized so the starter snippet — eleven lines, the longest
 * of them a `console.log` call — sits inside it whole, with room left for the
 * output tray the first run opens. The previous 500×280 fitted the snippet to
 * the pixel: on a board fitted to a laptop screen the text landed around 10
 * screen pixels and every cell opened already scrolling.
 */
export const DEFAULT_CODE_WIDTH = 640;
export const DEFAULT_CODE_HEIGHT = 400;
export const MIN_CODE_WIDTH = 260;
export const MIN_CODE_HEIGHT = 140;
export const MAX_CODE_WIDTH = 20_000;
export const MAX_CODE_HEIGHT = 20_000;

export const MAX_CODE_CHARS = 50_000;
export const MAX_CODE_OUTPUT_CHARS = 4_000;

/**
 * Only languages the runner can actually execute belong here: the picker is
 * built from this list, so anything listed is something a user can select and
 * press Run on. Adding one means adding its toolchain to the runner's container
 * image and its argv to the runner's language table in the same change —
 * `apps/code-runner/src/languages.ts` asserts the two lists agree, so a
 * language added here alone fails that suite rather than reaching a user as a
 * Run button that 500s.
 *
 * Ordered as the picker shows them: interpreted first, then compiled, each
 * group roughly by how often a whiteboard reaches for it.
 */
export const CODE_LANGUAGES = [
  "python",
  "javascript",
  "typescript",
  "java",
  "c",
  "cpp",
  "go",
  "rust",
] as const;

export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/**
 * Terminal states only. "Running" is deliberately absent: it is the runner's
 * own local state, never a synced prop. A synced running flag has no owner —
 * whoever set it can close their tab mid-run, and the board is then stuck
 * showing "Running…" to everyone with nothing left to clear it.
 */
export const CODE_EXECUTION_STATUSES = ["idle", "success", "error"] as const;

export type CodeExecutionStatus = (typeof CODE_EXECUTION_STATUSES)[number];

/**
 * `code` is what the author typed and `output` is what the last run produced —
 * both synced, so a collaborator who joins after a run sees the result that is
 * already on the board rather than an empty tray.
 *
 * `output` carries stdout and stderr already merged into one display string.
 * The split matters while a run is in flight and nowhere after: `status` says
 * how it ended, and the tray renders one block either way. Keeping them apart
 * in the record would mean two bounded fields whose combined length no single
 * validator constrains, which is exactly the bug that shape once had.
 */
export interface CodeShapeProps {
  w: number;
  h: number;
  code: string;
  language: CodeLanguage;
  output: string;
  status: CodeExecutionStatus;
  executionTimeMs: number;
}

declare module "@tldraw/tlschema" {
  export interface TLGlobalShapePropsMap {
    [CODE_SHAPE_TYPE]: CodeShapeProps;
  }
}

export type CodeShape = TLShape<typeof CODE_SHAPE_TYPE>;

const boundedDimension = (label: string, minimum: number, maximum: number) =>
  T.number.check(label, (value) => {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`Expected ${label} to be in range ${minimum}..${maximum}`);
    }
  });

const boundedString = (label: string, maximum: number) =>
  T.string.check(label, (value) => {
    if (value.length > maximum) {
      throw new Error(`Expected ${label} to be at most ${maximum} characters`);
    }
  });

export const CODE_SHAPE_PROPS = {
  w: boundedDimension("code width", MIN_CODE_WIDTH, MAX_CODE_WIDTH),
  h: boundedDimension("code height", MIN_CODE_HEIGHT, MAX_CODE_HEIGHT),
  code: boundedString("code content", MAX_CODE_CHARS),
  language: T.literalEnum(...CODE_LANGUAGES),
  output: boundedString("code output", MAX_CODE_OUTPUT_CHARS),
  status: T.literalEnum(...CODE_EXECUTION_STATUSES),
  executionTimeMs: T.number.check("execution time", (value) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Expected execution time to be a non-negative finite number");
    }
  }),
};

/**
 * Every starter is a complete, runnable program that prints something, because
 * the first thing anyone does with a fresh cell is press Run. A starter that
 * needed editing first would make the language look broken.
 *
 * The Java one must declare `class Main`: the runner compiles it as `Main.java`
 * and launches `Main`, which is the only naming a single-file javac accepts.
 */
const STARTER_CODE: Record<CodeLanguage, string> = {
  python: `# Write Python and press Run (Ctrl/Cmd + Enter)\ndef fibonacci(n):\n    seq = [0, 1]\n    for i in range(2, n):\n        seq.append(seq[i - 1] + seq[i - 2])\n    return seq\n\n\nprint("Fibonacci sequence:", fibonacci(8))\n`,
  javascript: `// Write JavaScript and press Run (Ctrl/Cmd + Enter)\nfunction fibonacci(n) {\n  const seq = [0, 1];\n  for (let i = 2; i < n; i++) {\n    seq.push(seq[i - 1] + seq[i - 2]);\n  }\n  return seq;\n}\n\nconsole.log("Fibonacci sequence:", fibonacci(8));\n`,
  typescript: `// Write TypeScript and press Run (Ctrl/Cmd + Enter)\nfunction fibonacci(n: number): number[] {\n  const seq = [0, 1];\n  for (let i = 2; i < n; i++) {\n    seq.push(seq[i - 1] + seq[i - 2]);\n  }\n  return seq;\n}\n\nconsole.log("Fibonacci sequence:", fibonacci(8));\n`,
  java: `// Write Java and press Run (Ctrl/Cmd + Enter)\n// The entry point must stay \`class Main\`.\nimport java.util.ArrayList;\nimport java.util.List;\n\nclass Main {\n    static List<Integer> fibonacci(int n) {\n        List<Integer> seq = new ArrayList<>(List.of(0, 1));\n        for (int i = 2; i < n; i++) {\n            seq.add(seq.get(i - 1) + seq.get(i - 2));\n        }\n        return seq;\n    }\n\n    public static void main(String[] args) {\n        System.out.println("Fibonacci sequence: " + fibonacci(8));\n    }\n}\n`,
  c: `// Write C and press Run (Ctrl/Cmd + Enter)\n#include <stdio.h>\n\nint main(void) {\n    int seq[8] = {0, 1};\n    for (int i = 2; i < 8; i++) {\n        seq[i] = seq[i - 1] + seq[i - 2];\n    }\n\n    printf("Fibonacci sequence:");\n    for (int i = 0; i < 8; i++) {\n        printf(" %d", seq[i]);\n    }\n    printf("\\n");\n    return 0;\n}\n`,
  cpp: `// Write C++ and press Run (Ctrl/Cmd + Enter)\n#include <iostream>\n#include <vector>\n\nint main() {\n    std::vector<int> seq{0, 1};\n    for (int i = 2; i < 8; i++) {\n        seq.push_back(seq[i - 1] + seq[i - 2]);\n    }\n\n    std::cout << "Fibonacci sequence:";\n    for (int value : seq) {\n        std::cout << ' ' << value;\n    }\n    std::cout << '\\n';\n}\n`,
  go: `// Write Go and press Run (Ctrl/Cmd + Enter)\npackage main\n\nimport "fmt"\n\nfunc fibonacci(n int) []int {\n\tseq := []int{0, 1}\n\tfor i := 2; i < n; i++ {\n\t\tseq = append(seq, seq[i-1]+seq[i-2])\n\t}\n\treturn seq\n}\n\nfunc main() {\n\tfmt.Println("Fibonacci sequence:", fibonacci(8))\n}\n`,
  rust: `// Write Rust and press Run (Ctrl/Cmd + Enter)\nfn fibonacci(n: usize) -> Vec<u64> {\n    let mut seq = vec![0, 1];\n    for i in 2..n {\n        seq.push(seq[i - 1] + seq[i - 2]);\n    }\n    seq\n}\n\nfn main() {\n    println!("Fibonacci sequence: {:?}", fibonacci(8));\n}\n`,
};

export function createCodeShapeProps(
  overrides: Partial<CodeShapeProps> = {},
): CodeShapeProps {
  const language = overrides.language ?? "javascript";
  return {
    w: DEFAULT_CODE_WIDTH,
    h: DEFAULT_CODE_HEIGHT,
    code: STARTER_CODE[language],
    language,
    output: "",
    status: "idle",
    executionTimeMs: 0,
    ...overrides,
  };
}

/** The starter snippet a freshly picked language should drop into an untouched cell. */
export function getStarterCode(language: CodeLanguage): string {
  return STARTER_CODE[language];
}

export function isStarterCode(code: string): boolean {
  return Object.values(STARTER_CODE).some((starter) => starter === code);
}

const codeShapeVersions = createShapePropsMigrationIds(CODE_SHAPE_TYPE, {
  Initial: 1,
  RetireJsonLanguage: 2,
});

export const CODE_SHAPE_MIGRATIONS = createShapePropsMigrationSequence({
  sequence: [
    {
      id: codeShapeVersions.Initial,
      up(props) {
        // Every branch clamps rather than throws. A migration that rejects a
        // record takes the whole room snapshot down with it, and none of these
        // fields is load-bearing enough to be worth that: a code cell that
        // comes back as an empty JavaScript block is recoverable, a board that
        // will not open is not.
        props.code =
          typeof props.code === "string" ? props.code.slice(0, MAX_CODE_CHARS) : "";

        // Folds anything unrecognized onto a runner that exists. This list has
        // grown since, so values this once flattened (`python`, `typescript`)
        // now survive it intact — which is what their authors meant all along.
        if (
          typeof props.language !== "string" ||
          !CODE_LANGUAGES.includes(props.language as CodeLanguage)
        ) {
          props.language = "javascript";
        }

        props.output =
          typeof props.output === "string"
            ? props.output.slice(0, MAX_CODE_OUTPUT_CHARS)
            : "";

        // Also the landing place for the retired `running` status, which is how
        // a board saved mid-run recovers instead of staying stuck.
        if (
          typeof props.status !== "string" ||
          !CODE_EXECUTION_STATUSES.includes(props.status as CodeExecutionStatus)
        ) {
          props.status = "idle";
        }

        if (
          typeof props.executionTimeMs !== "number" ||
          !Number.isFinite(props.executionTimeMs) ||
          props.executionTimeMs < 0
        ) {
          props.executionTimeMs = 0;
        }

        props.w = clampFinite(props.w, MIN_CODE_WIDTH, MAX_CODE_WIDTH, DEFAULT_CODE_WIDTH);
        props.h = clampFinite(props.h, MIN_CODE_HEIGHT, MAX_CODE_HEIGHT, DEFAULT_CODE_HEIGHT);

        // Ownership of a run was never resolved by a synced string; it is gone.
        delete props.lockedBy;
      },
      down(props) {
        props.lockedBy = null;
      },
    },
    {
      id: codeShapeVersions.RetireJsonLanguage,
      up(props) {
        // `json` was never execution — it pretty-printed in the browser — and
        // has no toolchain in the runner. Records that stopped at version 1
        // still carry it, and the validator would reject them on load, so they
        // are folded here rather than at `Initial`, which they have run past.
        //
        // The source is deliberately left alone: a JSON document in a cell now
        // labelled JavaScript is visibly wrong and one keystroke from right,
        // whereas discarding it would be silent and final.
        if (
          typeof props.language !== "string" ||
          !CODE_LANGUAGES.includes(props.language as CodeLanguage)
        ) {
          props.language = "javascript";
        }
      },
      down(props) {
        // There is no honest inverse: `json` is gone from the runner, so a
        // downgrade keeps the language it was folded to rather than inventing
        // one this schema can no longer run.
        props.language = props.language ?? "javascript";
      },
    },
  ],
});

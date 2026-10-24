import {
  MAX_CODE_RUN_STREAM_BYTES,
  type CodeRunResult,
} from "@orbmeet/whiteboard-core/code-run-contract";
import { MAX_CODE_OUTPUT_CHARS } from "@orbmeet/whiteboard-core/code-shape-schema";

const TRUNCATION_MARKER = "\n… output truncated";

const CAPTURE_NOTICE =
  `… the runner stopped capturing output at ${MAX_CODE_RUN_STREAM_BYTES / 1024} KB.`;

/** What composing an output needs from a run. */
export type ComposableRun = Pick<
  CodeRunResult,
  "stdout" | "stderr" | "compileStderr" | "phase" | "truncated"
>;

/**
 * Assembles everything a run produced into the single bounded string the shape
 * stores.
 *
 * This is the only place that assembly happens, labels included. Splitting it —
 * labelling in the component, merging here — is how the compile/run distinction
 * the runner works to preserve gets lost on its last hop: whoever writes the
 * label has to know the budget, or the label is what falls off the end.
 *
 * Sections appear in the order they were produced, and lose space in reverse
 * order of what a reader needs: the error first, then the notice explaining that
 * output is missing, then the program's own output, and warnings last — a
 * warning about code that then failed is the least of the author's problems.
 */
export function composeOutput(
  result: ComposableRun,
  maxChars: number = MAX_CODE_OUTPUT_CHARS,
): string {
  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();
  const compileStderr = result.compileStderr.trimEnd();

  // A compiler's diagnostics are about the source, not something the program
  // printed. The label is part of the stored output rather than a prop of its
  // own so that a collaborator who joins later sees it too.
  const sections = [
    compileStderr && result.phase === "run" ? `Compile warnings:\n${compileStderr}` : "",
    stdout,
    stderr && result.phase === "compile" ? `Compile error:\n${stderr}` : stderr,
    result.truncated ? CAPTURE_NOTICE : "",
  ];
  const keepOrder = [2, 3, 1, 0];

  const kept = sections.map(() => "");
  let budget = maxChars;
  let count = 0;
  for (const index of keepOrder) {
    const text = sections[index] ?? "";
    if (!text) continue;
    const separator = count > 0 ? 1 : 0;
    const available = budget - separator;
    // Room for a marker and nothing else is not room for a section: it would
    // spend the remaining budget saying only that something was dropped.
    if (available <= TRUNCATION_MARKER.length) break;
    const fitted = truncate(text, available);
    kept[index] = fitted;
    budget -= fitted.length + separator;
    count += 1;
  }

  return kept.filter(Boolean).join("\n");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

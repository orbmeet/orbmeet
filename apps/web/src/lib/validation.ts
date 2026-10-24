import * as v from "valibot";
import { AppError } from "./app-errors";

// Every schema failure leaves the server through here.
//
// A Valibot issue carries the rejected input, and each step of its path carries
// the whole object around it. Serialised as-is, that puts the request body — a
// step-up code, a flow token — into a log line or a response. So issues are
// reduced to messages keyed by field before they go anywhere.

/** Field messages keyed by dot path; `root` holds those about the whole input. */
export interface ValidationDetails {
  root?: string[];
  nested?: Record<string, string[]>;
}

type Issues = [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]];

/** The first issue as one line, prefixed with the field it is about. */
function describeIssue(issue: v.BaseIssue<unknown>): string {
  const path = v.getDotPath(issue);
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** A 400 naming the first problem, with every field's messages as its data. */
export function validationError(issues: Issues): AppError<ValidationDetails> {
  const { root, nested, other } = v.flatten(issues);
  const details: ValidationDetails = {};
  if (root || other) details.root = [...(root ?? []), ...(other ?? [])];
  if (nested) details.nested = nested as Record<string, string[]>;
  return new AppError("VALIDATION_ERROR", describeIssue(issues[0]), 400, details);
}

/** Parse `value`, throwing `validationError` when it does not fit. */
export function parseInput<const Schema extends v.GenericSchema>(
  schema: Schema,
  value: unknown,
): v.InferOutput<Schema> {
  const result = v.safeParse(schema, value);
  if (result.success) return result.output;
  throw validationError(result.issues);
}

/**
 * A server function's input validator.
 *
 * Start validates through Standard Schema and, on failure, throws the issues
 * serialised into an error message, input and all. This keeps the schema's
 * types for the caller but fails with `validationError` instead: a 400 the
 * client can show, carrying messages only.
 */
/* @__NO_SIDE_EFFECTS__ */
export function serverInput<const Schema extends v.GenericSchema>(
  schema: Schema,
): { readonly "~standard": v.StandardProps<v.InferInput<Schema>, v.InferOutput<Schema>> } {
  return {
    "~standard": {
      version: 1,
      vendor: "valibot",
      validate: (value) => ({ value: parseInput(schema, value) }),
    },
  };
}

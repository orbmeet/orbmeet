import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { AppError } from "./app-errors";
import { parseInput, serverInput, validationError } from "./validation";

const credentialSchema = v.object({
  sessionId: v.pipe(v.string(), v.nonEmpty("Session is required")),
  credential: v.object({ flowToken: v.string(), otp: v.pipe(v.string(), v.regex(/^\d{6}$/, "Code must be 6 digits")) }),
});
const body = { sessionId: "", credential: { flowToken: "SECRET-FLOW-TOKEN", otp: "12345" } };

function issuesOf(value: unknown) {
  const result = v.safeParse(credentialSchema, value);
  if (result.success) throw new Error("expected a failure");
  return result.issues;
}

describe("validationError", () => {
  it("names the first problem and keeps every field's messages", () => {
    const error = validationError(issuesOf(body));
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe("sessionId: Session is required");
    expect(error.data).toEqual({
      nested: {
        sessionId: ["Session is required"],
        "credential.otp": ["Code must be 6 digits"],
      },
    });
  });

  it("carries no part of the rejected input", () => {
    const error = validationError(issuesOf(body));
    const serialized = JSON.stringify({ message: error.message, data: error.data });
    expect(serialized).not.toContain("SECRET-FLOW-TOKEN");
    expect(serialized).not.toContain("12345");
  });

  it("puts issues about the whole input under root", () => {
    expect(validationError(issuesOf("not an object")).data).toEqual({
      root: ["Invalid type: Expected Object but received \"not an object\""],
    });
  });
});

describe("parseInput", () => {
  it("returns the output or throws a validation error", () => {
    const valid = { sessionId: "s", credential: { flowToken: "t", otp: "123456" } };
    expect(parseInput(credentialSchema, valid)).toEqual(valid);
    expect(() => parseInput(credentialSchema, body)).toThrow(AppError);
  });
});

describe("serverInput", () => {
  it("validates through Standard Schema and fails with the validation error", async () => {
    const validator = serverInput(v.object({ limit: v.optional(v.number(), 30) }));
    expect(await validator["~standard"].validate({})).toEqual({ value: { limit: 30 } });
    expect(() => validator["~standard"].validate({ limit: "x" })).toThrow("limit: Invalid type");
  });
});

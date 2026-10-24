import { describe, expect, it } from "vitest";
import { AppError, Errors } from "@/lib/app-errors";
import {
  getSafeRouteErrorMessage,
  getServerErrorCode,
  getServerErrorStringValue,
  getServerErrorStatusCode,
  isServerError,
} from "./error-inspection";

/**
 * Reproduce how a structured serializer (seroval — what TanStack Start uses to
 * marshal server-function results and errors) carries an Error across the RPC
 * boundary: its `name`, `message`, and own *enumerable* properties survive, but
 * the class identity (`instanceof AppError`) does not. This is a contract guard,
 * not a live network round-trip — the real HTTP hop is exercised by the running
 * app. Its job is to fail loudly if `AppError` ever stops exposing
 * `code`/`statusCode`/`data` in a serializable shape, which would silently break
 * the retry-gating in `router.tsx` / `queries/session.ts` (auth errors would be
 * retried instead of failing fast).
 */
function marshalAcrossRpcBoundary(error: Error): Record<string, unknown> {
  const wire: Record<string, unknown> = { name: error.name, message: error.message };
  for (const key of Object.keys(error)) {
    wire[key] = (error as unknown as Record<string, unknown>)[key];
  }
  return wire;
}

describe("server error helpers", () => {
  it("reads top-level server error metadata", () => {
    const error = Object.assign(new Error("boom"), {
      code: "MEETING_NOT_STARTED",
      statusCode: 404,
    });

    expect(getServerErrorCode(error)).toBe("MEETING_NOT_STARTED");
    expect(getServerErrorStatusCode(error)).toBe(404);
    expect(isServerError(error)).toBe(true);
  });

  it("reads nested server error metadata from wrapped errors", () => {
    const error = {
      data: {
        error: {
          cause: {
            code: "MEETING_NOT_STARTED",
            statusCode: 404,
          },
        },
      },
    };

    expect(getServerErrorCode(error)).toBe("MEETING_NOT_STARTED");
    expect(getServerErrorStatusCode(error)).toBe(404);
  });

  it("reads custom string metadata from wrapped server errors", () => {
    const error = {
      cause: {
        data: {
          code: "AWAITING_APPROVAL",
          admissionId: "MEETING_ADMISSION_123",
        },
      },
    };

    expect(getServerErrorStringValue(error, "admissionId")).toBe("MEETING_ADMISSION_123");
  });

  it("returns undefined for non-server errors", () => {
    expect(getServerErrorCode(new Error("network"))).toBeUndefined();
    expect(getServerErrorStatusCode({})).toBeUndefined();
    expect(getServerErrorStringValue({}, "admissionId")).toBeUndefined();
    expect(isServerError(new Error("network"))).toBe(false);
  });
});

describe("getSafeRouteErrorMessage", () => {
  it("keeps expected client errors actionable", () => {
    expect(getSafeRouteErrorMessage(Errors.FORBIDDEN("Ask the Space owner"))).toBe(
      "Ask the Space owner",
    );
  });

  it("redacts unknown and server-side failure messages", () => {
    expect(getSafeRouteErrorMessage(new Error("D1_ERROR: no such column users.secret"))).toBe(
      "Something went wrong",
    );
    expect(getSafeRouteErrorMessage(
      Object.assign(new Error("Paddle API key abc123 failed"), { statusCode: 500 }),
      "Unable to load this page",
    )).toBe("Unable to load this page");
  });
});

describe("AppError survives the server-fn serialization boundary", () => {
  it("recovers code and statusCode from a marshalled AppError", () => {
    const wire = marshalAcrossRpcBoundary(Errors.FORBIDDEN());

    expect(getServerErrorCode(wire)).toBe("FORBIDDEN");
    expect(getServerErrorStatusCode(wire)).toBe(403);
  });

  it("recovers the terminal codes that gate retries in router.tsx / session.ts", () => {
    for (const error of [
      Errors.UNAUTHORIZED(),
      Errors.FORBIDDEN(),
      Errors.NOT_FOUND(),
      Errors.VALIDATION("bad input"),
    ]) {
      const expected = error.code;
      expect(getServerErrorCode(marshalAcrossRpcBoundary(error))).toBe(expected);
    }
  });

  it("recovers nested app-error data (admissionId) after marshalling", () => {
    const wire = marshalAcrossRpcBoundary(
      new AppError("CONFLICT", "Busy", 409, { admissionId: "MEETING_ADMISSION_123" }),
    );

    expect(getServerErrorCode(wire)).toBe("CONFLICT");
    expect(getServerErrorStringValue(wire, "admissionId")).toBe("MEETING_ADMISSION_123");
  });

  it("exposes metadata as own enumerable properties (the serialization precondition)", () => {
    // If a refactor makes these non-enumerable (private fields, getters, or
    // defineProperty without `enumerable: true`), structured serializers drop
    // them and the assertions above would pass only against this stale mock —
    // so assert the precondition directly against a real instance.
    const ownKeys = Object.keys(Errors.FORBIDDEN());
    expect(ownKeys).toEqual(expect.arrayContaining(["code", "statusCode"]));
  });
});

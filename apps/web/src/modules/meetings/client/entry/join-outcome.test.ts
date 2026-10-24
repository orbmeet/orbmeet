import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/app-errors";
import type { JoinResult } from "@/modules/meetings/contract/types";
import {
  classifyJoinError,
  classifyJoinResponse,
  isStaleReconnectRejection,
} from "./join-outcome";

const result = { token: "t", serverUrl: "wss://node" } as JoinResult;

describe("classifyJoinResponse", () => {
  it("admits a joined response that carries credentials", () => {
    expect(classifyJoinResponse({ state: "joined", result })).toEqual({
      kind: "admitted",
      access: result,
    });
  });

  it("refuses a joined response without credentials", () => {
    expect(
      classifyJoinResponse({ state: "joined", result: { ...result, token: "" } }),
    ).toMatchObject({ kind: "final" });
  });

  it("waits for approval with the admission to poll on", () => {
    expect(
      classifyJoinResponse({
        state: "waiting",
        reason: "approval",
        message: "Waiting",
        admissionId: "adm_1",
      }),
    ).toEqual({ kind: "wait", reason: "approval", admissionId: "adm_1" });
  });

  it("cannot wait for approval without an admission to poll on", () => {
    expect(
      classifyJoinResponse({ state: "waiting", reason: "approval", message: "Waiting" }),
    ).toMatchObject({ kind: "final" });
  });

  it("waits for a meeting that has not started", () => {
    expect(
      classifyJoinResponse({ state: "waiting", reason: "meeting-start", message: "Not yet" }),
    ).toEqual({ kind: "wait", reason: "meeting-start", admissionId: null });
  });

  it("follows the server's retryable flag, never the status", () => {
    expect(
      classifyJoinResponse({ state: "blocked", code: "CONFLICT", message: "Busy", retryable: true }),
    ).toMatchObject({ kind: "retry", code: "CONFLICT" });
    expect(
      classifyJoinResponse({
        state: "blocked",
        code: "PLAN_LIMIT_REACHED",
        message: "Plan limit reached: Meeting is full",
        retryable: false,
      }),
    ).toEqual({ kind: "final", code: "PLAN_LIMIT_REACHED", message: "Meeting is full." });
  });

  it("keeps the server's words when the plan's one running meeting is taken", () => {
    expect(
      classifyJoinResponse({
        state: "blocked",
        code: "PLAN_LIMIT_REACHED",
        message: "Plan limit reached: Maximum 1 concurrent meeting(s) on your plan",
        retryable: false,
      }),
    ).toEqual({
      kind: "final",
      code: "PLAN_LIMIT_REACHED",
      message: "Plan limit reached: Maximum 1 concurrent meeting(s) on your plan",
    });
  });

  it("shows a moderator's denial in the server's words", () => {
    expect(
      classifyJoinResponse({
        state: "blocked",
        code: "MEETING_ADMISSION_DENIED",
        message: "Your access to this meeting was revoked.",
        retryable: false,
      }),
    ).toMatchObject({ message: "Your access to this meeting was revoked." });
  });
});

describe("classifyJoinError", () => {
  it("retries an infrastructure failure that is not an application error", () => {
    expect(classifyJoinError(new Error("fetch failed"))).toMatchObject({ kind: "retry", code: null });
  });

  it("retries throttling from the rate-limit middleware", () => {
    expect(
      classifyJoinError(new AppError("RATE_LIMITED", "Too many", 429)),
    ).toMatchObject({ kind: "retry", code: "RATE_LIMITED" });
  });

  it("retries a server error of any code", () => {
    expect(
      classifyJoinError(new AppError("SOMETHING_NEW", "Oops", 503)),
    ).toMatchObject({ kind: "retry" });
  });

  it("stops at an application error that retrying cannot change", () => {
    expect(
      classifyJoinError(new AppError("VALIDATION_ERROR", "Bad code", 400)),
    ).toMatchObject({ kind: "final", code: "VALIDATION_ERROR" });
  });
});

describe("isStaleReconnectRejection", () => {
  it("flags a forbidden join so the stored admission id can be discarded", () => {
    expect(
      isStaleReconnectRejection({
        state: "blocked",
        code: "FORBIDDEN",
        message: "Forbidden",
        retryable: false,
      }),
    ).toBe(true);
  });

  it("leaves other refusals and every non-refusal alone", () => {
    // A denied admission is cleared where it is handled, and retrying without
    // the id would only knock again at a door that was closed on purpose.
    expect(
      isStaleReconnectRejection({
        state: "blocked",
        code: "MEETING_ADMISSION_DENIED",
        message: "Denied",
        retryable: false,
      }),
    ).toBe(false);
    expect(
      isStaleReconnectRejection({
        state: "waiting",
        reason: "approval",
        message: "Waiting",
        admissionId: "adm_1",
      }),
    ).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { callCoordinator } from "./client.server";

function envWith(handle: () => Promise<unknown>) {
  const get = vi.fn(() => ({ handle }));
  const env = { MEETING_ROOM: { idFromName: (name: string) => name, get } } as unknown as Env;
  return { env, get };
}

function infraError(flags: { retryable?: boolean; overloaded?: boolean }) {
  return Object.assign(new Error("Durable Object reset"), flags);
}

const wake = { kind: "wake", meetingId: "meeting_1" } as const;

describe("callCoordinator", () => {
  it("retries a transient failure on a fresh stub", async () => {
    const handle = vi
      .fn()
      .mockRejectedValueOnce(infraError({ retryable: true }))
      .mockResolvedValueOnce({ ok: true, value: { kind: "ok" } });
    const { env, get } = envWith(handle);

    await expect(callCoordinator(env, wake)).resolves.toEqual({ kind: "ok" });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not retry an overloaded room, or a failure that is not transient", async () => {
    for (const error of [infraError({ retryable: true, overloaded: true }), infraError({})]) {
      const handle = vi.fn().mockRejectedValue(error);
      await expect(callCoordinator(envWith(handle).env, wake)).rejects.toBe(error);
      expect(handle).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up after a bounded number of attempts", async () => {
    const error = infraError({ retryable: true });
    const handle = vi.fn().mockRejectedValue(error);
    await expect(callCoordinator(envWith(handle).env, wake)).rejects.toBe(error);
    expect(handle).toHaveBeenCalledTimes(3);
  });

  it("throws a refusal as the AppError it is, without retrying", async () => {
    const handle = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "MEETING_ENDED", message: "Meeting has ended", statusCode: 410 },
    });
    await expect(callCoordinator(envWith(handle).env, wake)).rejects.toMatchObject({
      code: "MEETING_ENDED",
      statusCode: 410,
    });
    expect(handle).toHaveBeenCalledTimes(1);
  });
});

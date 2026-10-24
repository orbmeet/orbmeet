import { describe, expect, it, vi } from "vitest";
import { isRedirect } from "@tanstack/react-router";
import { onlineManager } from "@tanstack/react-query";
import { resolveSessionGate } from "./auth-gate";

function makeContext(overrides: {
  fetchQuery?: (options?: unknown) => Promise<unknown>;
  getQueryData?: () => unknown;
}) {
  return {
    queryClient: {
      fetchQuery: overrides.fetchQuery ?? (() => Promise.resolve(null)),
      getQueryData: overrides.getQueryData ?? (() => undefined),
    },
  } as any;
}

const location = {
  href: "/meetings?q=recent#latest",
  pathname: "/meetings",
  searchStr: "?q=recent",
};

describe("resolveSessionGate", () => {
  it("redirects to auth when the session resolves to null", async () => {
    const error: unknown = await resolveSessionGate(makeContext({}), location).then(
      () => new Error("Expected an authentication redirect"),
      (cause: unknown) => cause,
    );
    expect(isRedirect(error)).toBe(true);
    if (!isRedirect(error)) throw new Error("Expected a TanStack redirect");
    expect(error.options).toMatchObject({
      to: "/auth",
      search: { mode: "login", redirect: "/meetings?q=recent#latest" },
    });
  });

  it("falls back to a cached session on transient fetch errors", async () => {
    const session = { user: { id: "usr_123" } };

    await expect(
      resolveSessionGate(
        makeContext({
          fetchQuery: async () => {
            throw new Error("temporary failure");
          },
          getQueryData: () => session,
        }),
        location,
      ),
    ).resolves.toEqual({ session });
  });

  it("rethrows cold-load fetch failures instead of redirecting to auth", async () => {
    const error = new Error("database unavailable");

    await expect(
      resolveSessionGate(
        makeContext({
          fetchQuery: async () => {
            throw error;
          },
        }),
        location,
      ),
    ).rejects.toBe(error);
  });

  it("does not allow the awaited auth fetch to pause on connectivity changes", async () => {
    const session = { user: { id: "usr_123" } };
    const fetchQuery = vi.fn(() => Promise.resolve(session));

    await expect(
      resolveSessionGate(makeContext({ fetchQuery }), location),
    ).resolves.toEqual({ session });
    expect(fetchQuery).toHaveBeenCalledWith(
      expect.objectContaining({ networkMode: "always" }),
    );
  });

  it("uses the cached authenticated session without starting an offline fetch", async () => {
    const session = { user: { id: "usr_123" } };
    const fetchQuery = vi.fn(() => Promise.resolve(null));
    const onlineSpy = vi.spyOn(onlineManager, "isOnline").mockReturnValue(false);

    try {
      await expect(
        resolveSessionGate(
          makeContext({ fetchQuery, getQueryData: () => session }),
          location,
        ),
      ).resolves.toEqual({ session });
      expect(fetchQuery).not.toHaveBeenCalled();
    } finally {
      onlineSpy.mockRestore();
    }
  });

  it("fails a cold offline auth check instead of leaving navigation pending", async () => {
    const fetchQuery = vi.fn(() => Promise.resolve(null));
    const onlineSpy = vi.spyOn(onlineManager, "isOnline").mockReturnValue(false);

    try {
      await expect(
        resolveSessionGate(makeContext({ fetchQuery }), location),
      ).rejects.toThrow("Authentication cannot be verified while offline");
      expect(fetchQuery).not.toHaveBeenCalled();
    } finally {
      onlineSpy.mockRestore();
    }
  });
});

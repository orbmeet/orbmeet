import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadStoredMeetingDisplayName,
  saveStoredMeetingDisplayName,
} from "./display-name-storage";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("meeting display-name storage", () => {
  it("reads and writes when storage is available", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });

    saveStoredMeetingDisplayName("Ada");
    expect(loadStoredMeetingDisplayName()).toBe("Ada");
  });

  it("treats throwing storage as unavailable", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new DOMException("blocked", "SecurityError");
        },
        setItem: () => {
          throw new DOMException("blocked", "SecurityError");
        },
      },
    });

    expect(loadStoredMeetingDisplayName()).toBeNull();
    expect(() => saveStoredMeetingDisplayName("Ada")).not.toThrow();
  });
});

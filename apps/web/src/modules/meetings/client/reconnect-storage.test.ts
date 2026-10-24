import { beforeEach, describe, expect, it } from "vitest";
import {
  clearReconnectAdmissionId,
  loadReconnectAdmissionId,
  persistReconnectAdmissionId,
} from "./reconnect-storage";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("reconnect storage", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
  });

  it("stores reconnect ids in tab-scoped session storage", () => {
    persistReconnectAdmissionId("abc-defg-hij", "admission_guest");

    expect(sessionStorage.getItem("orbmeet.admission.abc-defg-hij")).toContain("admission_guest");
    expect(localStorage.getItem("orbmeet.admission.abc-defg-hij")).toBeNull();
    expect(loadReconnectAdmissionId("abc-defg-hij")).toBe("admission_guest");
  });

  it("clears the stored id", () => {
    persistReconnectAdmissionId("abc-defg-hij", "admission_guest");

    clearReconnectAdmissionId("abc-defg-hij");

    expect(loadReconnectAdmissionId("abc-defg-hij")).toBeUndefined();
  });

  it("round-trips regardless of how the participant was admitted", () => {
    // The writer knows the server's answer; the reader only knows what the
    // client believes. A guest admission written while the client thought it was
    // authenticated (a cached session outliving its cookie) must still be found.
    persistReconnectAdmissionId("abc-defg-hij", "admission_from_guest_identity");

    expect(loadReconnectAdmissionId("abc-defg-hij")).toBe("admission_from_guest_identity");

    clearReconnectAdmissionId("abc-defg-hij");
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps meeting codes isolated from each other", () => {
    persistReconnectAdmissionId("abc-defg-hij", "admission_one");
    persistReconnectAdmissionId("klm-nopq-rst", "admission_two");

    clearReconnectAdmissionId("abc-defg-hij");

    expect(loadReconnectAdmissionId("abc-defg-hij")).toBeUndefined();
    expect(loadReconnectAdmissionId("klm-nopq-rst")).toBe("admission_two");
  });
});

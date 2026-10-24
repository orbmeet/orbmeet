import { describe, it, expect } from "vitest";
import { validateOrigin, validateCsrfOrigin } from "@/platform/http/origin-validation";

describe("Empirical CSRF Origin Protection Verification", () => {
  const productionOptions = {
    appUrl: "https://app.orbmeet.com",
    environment: "production",
  };

  describe("a. validateOrigin in Production", () => {
    it("fails closed when APP_URL is missing in production", () => {
      const request = new Request("https://app.orbmeet.com/api/mutate", {
        method: "POST",
        headers: { Origin: "https://app.orbmeet.com" },
      });
      expect(validateOrigin(request, { environment: "production" })).toBe(false);
    });

    it("fails closed when APP_URL is invalid", () => {
      const request = new Request("https://app.orbmeet.com/api/mutate", {
        method: "POST",
        headers: { Origin: "https://app.orbmeet.com" },
      });
      expect(validateOrigin(request, { appUrl: "not-a-valid-url", environment: "production" })).toBe(false);
    });

    it("fails closed when both Origin and Referer headers are missing", () => {
      const request = new Request("https://app.orbmeet.com/api/mutate", {
        method: "POST",
      });
      expect(validateOrigin(request, productionOptions)).toBe(false);
    });

    it("fails closed when Origin does not match APP_URL (cross-origin attack attempt)", () => {
      const request = new Request("https://app.orbmeet.com/api/mutate", {
        method: "POST",
        headers: { Origin: "https://attacker.com" },
      });
      expect(validateOrigin(request, productionOptions)).toBe(false);
    });

    it("fails closed when Referer origin does not match APP_URL", () => {
      const request = new Request("https://app.orbmeet.com/api/mutate", {
        method: "POST",
        headers: { Referer: "https://attacker.com/malicious-page" },
      });
      expect(validateOrigin(request, productionOptions)).toBe(false);
    });

    it("accepts request when Origin matches APP_URL exactly", () => {
      const request = new Request("https://app.orbmeet.com/api/mutate", {
        method: "POST",
        headers: { Origin: "https://app.orbmeet.com" },
      });
      expect(validateOrigin(request, productionOptions)).toBe(true);
    });

    it("accepts request when Referer matches APP_URL origin", () => {
      const request = new Request("https://app.orbmeet.com/api/mutate", {
        method: "POST",
        headers: { Referer: "https://app.orbmeet.com/dashboard/spaces" },
      });
      expect(validateOrigin(request, productionOptions)).toBe(true);
    });

    it("allows all origins in local development", () => {
      const request = new Request("http://localhost:3000/api/mutate", {
        method: "POST",
        headers: { Origin: "http://localhost:5173" },
      });
      expect(validateOrigin(request, { appUrl: "http://localhost:3000", environment: "development" })).toBe(true);
    });

    it("keeps checking origins on a remote deployment configured as development", () => {
      const request = new Request("https://staging.orbmeet.com/api/mutate", {
        method: "POST",
        headers: { Origin: "https://attacker.example" },
      });
      expect(validateOrigin(request, { appUrl: "https://staging.orbmeet.com", environment: "development" })).toBe(false);
      expect(validateOrigin(request, { environment: "development" })).toBe(false);
    });
  });

  describe("b. validateCsrfOrigin HTTP Method Gating", () => {
    it("allows safe HTTP methods (GET, HEAD, OPTIONS) without origin headers", () => {
      const getReq = new Request("https://app.orbmeet.com/api/read", { method: "GET" });
      const headReq = new Request("https://app.orbmeet.com/api/read", { method: "HEAD" });
      const optionsReq = new Request("https://app.orbmeet.com/api/read", { method: "OPTIONS" });

      expect(validateCsrfOrigin(getReq, productionOptions)).toBe(true);
      expect(validateCsrfOrigin(headReq, productionOptions)).toBe(true);
      expect(validateCsrfOrigin(optionsReq, productionOptions)).toBe(true);
    });

    it("enforces origin validation on mutating HTTP methods (POST, PUT, PATCH, DELETE)", () => {
      const postReq = new Request("https://app.orbmeet.com/api/write", {
        method: "POST",
        headers: { Origin: "https://evil.com" },
      });
      const putReq = new Request("https://app.orbmeet.com/api/write", {
        method: "PUT",
        headers: { Origin: "https://evil.com" },
      });
      const patchReq = new Request("https://app.orbmeet.com/api/write", {
        method: "PATCH",
        headers: { Origin: "https://evil.com" },
      });
      const deleteReq = new Request("https://app.orbmeet.com/api/write", {
        method: "DELETE",
        headers: { Origin: "https://evil.com" },
      });

      expect(validateCsrfOrigin(postReq, productionOptions)).toBe(false);
      expect(validateCsrfOrigin(putReq, productionOptions)).toBe(false);
      expect(validateCsrfOrigin(patchReq, productionOptions)).toBe(false);
      expect(validateCsrfOrigin(deleteReq, productionOptions)).toBe(false);
    });
  });
});

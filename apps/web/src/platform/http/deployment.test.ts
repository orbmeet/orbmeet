import { describe, expect, it } from "vitest";
import { isLocalDevelopment } from "./deployment";

describe("isLocalDevelopment", () => {
  it("is a development deployment on this machine", () => {
    expect(isLocalDevelopment({ appUrl: "http://localhost:3000", environment: "development" })).toBe(true);
    expect(isLocalDevelopment({ appUrl: "http://127.0.0.1:3000", environment: "development" })).toBe(true);
    expect(isLocalDevelopment({ appUrl: "http://[::1]:3000", environment: "development" })).toBe(true);
  });

  it("is never a remote deployment, whatever it calls itself", () => {
    expect(isLocalDevelopment({ appUrl: "https://staging.example", environment: "development" })).toBe(false);
    expect(isLocalDevelopment({ environment: "development" })).toBe(false);
    expect(isLocalDevelopment({ appUrl: "not a url", environment: "development" })).toBe(false);
  });

  it("is never a deployment that does not say it is for development", () => {
    expect(isLocalDevelopment({ appUrl: "http://localhost:3000", environment: "production" })).toBe(false);
    expect(isLocalDevelopment({ appUrl: "http://localhost:3000" })).toBe(false);
    expect(isLocalDevelopment(undefined)).toBe(false);
  });
});

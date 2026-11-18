import { describe, expect, it } from "vitest";
import { stripCheckoutReturn } from "./checkout-return";

describe("stripCheckoutReturn", () => {
  it("removes the marker and keeps the rest of the URL", () => {
    expect(
      stripCheckoutReturn("https://orbmeet.example/settings?tab=plan-%26-billing&checkout=c_123#plan"),
    ).toEqual({ checkout: { organizationId: null }, strippedUrl: "/settings?tab=plan-%26-billing#plan" });
  });

  it("says which Organization bought, and removes that marker too", () => {
    expect(
      stripCheckoutReturn("https://orbmeet.example/settings?tab=plan-%26-billing&checkoutOrganization=org_1&checkout=c_123"),
    ).toEqual({ checkout: { organizationId: "org_1" }, strippedUrl: "/settings?tab=plan-%26-billing" });
  });

  it("returns null when the page is not a checkout return", () => {
    expect(stripCheckoutReturn("https://orbmeet.example/settings?tab=plan-%26-billing")).toBeNull();
    expect(stripCheckoutReturn("https://orbmeet.example/settings?checkoutOrganization=org_1")).toBeNull();
  });

  it("ignores an empty marker", () => {
    expect(stripCheckoutReturn("https://orbmeet.example/settings?checkout=")).toBeNull();
  });
});

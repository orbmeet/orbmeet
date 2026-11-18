import { describe, expect, it } from "vitest";
import { formatPlanPrice } from "./plan-prices";

describe("formatPlanPrice", () => {
  it.each([
    ["usd", 5, "$5"],
    ["eur", 5, "€5"],
    ["gbp", 4, "£4"],
    ["bdt", 600, "৳600"],
    ["inr", 450, "₹450"],
    ["bdt", 1200, "৳1,200"],
    ["jpy", 800, "¥800"],
  ])("shows %s %s as %s", (currency, amount, shown) => {
    expect(formatPlanPrice({ currency, amount })).toBe(shown);
  });

  it.each([
    ["cad", 7, "CA$7"],
    ["aud", 8, "A$8"],
  ])("never shows another dollar as a bare $: %s %s is %s", (currency, amount, shown) => {
    expect(formatPlanPrice({ currency, amount })).toBe(shown);
  });

  it("keeps the cents of an amount that has them", () => {
    expect(formatPlanPrice({ currency: "usd", amount: 4.99 })).toBe("$4.99");
  });
});

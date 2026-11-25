import { describe, expect, it } from "vitest";
import { seatChangeFor } from "./organization-seats.server";

const subscription = (seats: number, pendingSeats: number | null = null, cancelAtPeriodEnd = false, status = "active") => ({
  status,
  seats,
  pending_update: pendingSeats === null ? null : { seats: pendingSeats },
  cancel_at_period_end: cancelAtPeriodEnd,
});

describe("seatChangeFor", () => {
  it("raises seats now, invoiced, when members outnumber them", () => {
    expect(seatChangeFor(subscription(2), 3)).toEqual({ seats: 3, prorationBehavior: "invoice" });
  });

  it("lowers seats from the next period when members leave", () => {
    expect(seatChangeFor(subscription(5), 3)).toEqual({ seats: 3, prorationBehavior: "next_period" });
  });

  it("leaves a decrease already scheduled to the right count alone", () => {
    expect(seatChangeFor(subscription(5, 3), 3)).toBeNull();
  });

  it("cancels a scheduled decrease once members are back to the current seats", () => {
    expect(seatChangeFor(subscription(5, 3), 5)).toEqual({ seats: 5, prorationBehavior: "invoice" });
  });

  it("needs nothing when seats match members", () => {
    expect(seatChangeFor(subscription(3), 3)).toBeNull();
  });

  it("never goes below one seat", () => {
    expect(seatChangeFor(subscription(1), 0)).toBeNull();
    expect(seatChangeFor(subscription(2), 0)).toEqual({ seats: 1, prorationBehavior: "next_period" });
  });

  it("changes nothing on a subscription ending at its period's end", () => {
    expect(seatChangeFor(subscription(2, null, true), 3)).toBeNull();
  });

  it("changes nothing on a subscription Polar will not change in its status", () => {
    // Polar answers InactiveSubscription, which failed the daily reconciliation every day.
    for (const status of ["past_due", "unpaid", "paused", "incomplete"]) {
      expect(seatChangeFor(subscription(2, null, false, status), 3)).toBeNull();
    }
    expect(seatChangeFor(subscription(2, null, false, "trialing"), 3)).toEqual({ seats: 3, prorationBehavior: "invoice" });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  buildCheckoutOpenOptions,
  initializePaddleClient,
  subscribeToPaddleCheckoutCompletion,
} from "./paddle-checkout";

describe("buildCheckoutOpenOptions", () => {
  it("opens only the server-created transaction", () => {
    expect(
      buildCheckoutOpenOptions({
        transactionId: "txn_123",
      }),
    ).toEqual({
      settings: {
        displayMode: "overlay",
      },
      transactionId: "txn_123",
    });
  });
});

describe("initializePaddleClient", () => {
  it("selects the sandbox environment before initializing Paddle", () => {
    const calls: string[] = [];
    const paddle = {
      Environment: { set: vi.fn(() => calls.push("environment")) },
      Initialize: vi.fn(() => calls.push("initialize")),
      Checkout: { open: vi.fn() },
    };

    initializePaddleClient(paddle, "test_token");

    expect(calls).toEqual(["environment", "initialize"]);
    expect(paddle.Environment.set).toHaveBeenCalledWith("sandbox");
    expect(paddle.Initialize).toHaveBeenCalledWith(expect.objectContaining({
      token: "test_token",
    }));
  });

  // A live token must never quietly run against the sandbox checkout, so the
  // sandbox switch is driven by the token rather than a separate setting.
  it("leaves a live token on the production environment", () => {
    const paddle = {
      Environment: { set: vi.fn() },
      Initialize: vi.fn(),
      Checkout: { open: vi.fn() },
    };

    initializePaddleClient(paddle, "live_token");

    expect(paddle.Environment.set).not.toHaveBeenCalled();
    expect(paddle.Initialize).toHaveBeenCalledWith(expect.objectContaining({
      token: "live_token",
    }));
  });

  it("fails before initialization if the loaded Paddle.js cannot select sandbox", () => {
    const paddle = {
      Initialize: vi.fn(),
      Checkout: { open: vi.fn() },
    };

    expect(() => initializePaddleClient(paddle, "test_token"))
      .toThrow("cannot select the sandbox environment");
    expect(paddle.Initialize).not.toHaveBeenCalled();
  });

  it("publishes successful checkout completion to application subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToPaddleCheckoutCompletion(listener);
    const paddle = {
      Initialize: vi.fn(),
      Checkout: { open: vi.fn() },
    };
    initializePaddleClient(paddle, "live_token");
    const callback = paddle.Initialize.mock.calls[0]?.[0].eventCallback;

    callback?.({
      name: "checkout.completed",
      data: { transaction_id: "txn_123" },
    });

    expect(listener).toHaveBeenCalledWith({ transactionId: "txn_123" });
    unsubscribe();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findMatchingCheckoutTransaction,
  getOrCreatePaddleCustomer,
  getSubscription,
  paddleApiBase,
  PaddleApiError,
  resolveCheckoutTransaction,
  updateSubscriptionQuantity,
  verifyPaddleWebhookSignature,
} from "./paddle";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signPayload(body: string, secret: string, timestampSeconds: number) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestampSeconds}:${body}`));
  const hex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `ts=${timestampSeconds};h1=${hex}`;
}

describe("verifyPaddleWebhookSignature", () => {
  it("accepts a valid recent signature", async () => {
    const body = JSON.stringify({ event_type: "subscription.updated" });
    const secret = "test_secret";
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const header = await signPayload(body, secret, timestampSeconds);

    await expect(verifyPaddleWebhookSignature(body, header, secret)).resolves.toBe(true);
  });

  it("rejects stale signatures even when the HMAC is valid", async () => {
    const body = JSON.stringify({ event_type: "subscription.updated" });
    const secret = "test_secret";
    const timestampSeconds = Math.floor(Date.now() / 1000) - 301;
    const header = await signPayload(body, secret, timestampSeconds);

    await expect(verifyPaddleWebhookSignature(body, header, secret)).resolves.toBe(false);
  });

  it("accepts optional whitespace between header fields", async () => {
    const body = JSON.stringify({ event_type: "subscription.updated" });
    const secret = "test_secret";
    const timestampSeconds = Math.floor(Date.now() / 1000);
    const header = (await signPayload(body, secret, timestampSeconds))
      .replace(";", "; ")
      .replace("h1=", "h1 = ");

    await expect(verifyPaddleWebhookSignature(body, header, secret)).resolves.toBe(true);
  });

  it("rejects malformed signature headers", async () => {
    const body = JSON.stringify({ event_type: "subscription.updated" });

    await expect(
      verifyPaddleWebhookSignature(body, "ts=not-a-number;h1=xyz", "test_secret"),
    ).resolves.toBe(false);
  });
});

describe("updateSubscriptionQuantity", () => {
  const SEAT = "pri_01test000000000000000seat";
  const ADDON = "pri_01test0000000000000addon";

  function mockSubscription(items: Array<{ price: { id: string }; quantity?: number }>) {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: { method?: string }) =>
      Promise.resolve(new Response(
        JSON.stringify({ data: (init?.method ?? "GET") === "GET" ? { id: "sub_123", items } : {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function patchBody(fetchMock: ReturnType<typeof vi.fn>) {
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    return JSON.parse(patch![1].body as string) as {
      items: Array<{ price_id: string; quantity: number }>;
      proration_billing_mode: string;
    };
  }

  it("updates the recurring seat item with immediate proration", async () => {
    const fetchMock = mockSubscription([{ price: { id: SEAT }, quantity: 2 }]);

    await updateSubscriptionQuantity("api-key", "sub_123", SEAT, 4);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.paddle.com/subscriptions/sub_123",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(patchBody(fetchMock)).toEqual({
      items: [{ price_id: SEAT, quantity: 4 }],
      proration_billing_mode: "prorated_immediately",
    });
  });

  // Paddle removes any item left out of `items`, so a seat adjustment that sent
  // only the seat price would silently delete every other item on the
  // subscription.
  it("resends the subscription's other items so Paddle does not drop them", async () => {
    const fetchMock = mockSubscription([
      { price: { id: ADDON }, quantity: 3 },
      { price: { id: SEAT }, quantity: 2 },
    ]);

    await updateSubscriptionQuantity("api-key", "sub_123", SEAT, 7);

    expect(patchBody(fetchMock).items).toEqual([
      { price_id: ADDON, quantity: 3 },
      { price_id: SEAT, quantity: 7 },
    ]);
  });

  it("adds the seat price when the subscription does not carry it yet", async () => {
    const fetchMock = mockSubscription([{ price: { id: ADDON }, quantity: 1 }]);

    await updateSubscriptionQuantity("api-key", "sub_123", SEAT, 2);

    expect(patchBody(fetchMock).items).toEqual([
      { price_id: ADDON, quantity: 1 },
      { price_id: SEAT, quantity: 2 },
    ]);
  });

  it("rejects a zero seat quantity before calling Paddle", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateSubscriptionQuantity("api-key", "sub_123", SEAT, 0))
      .rejects.toThrow("positive integer");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("PaddleApiError", () => {
  it("carries the status so a 404 can be told apart from an outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("not found", { status: 404 }),
    ));

    const error = await getSubscription("api-key", "sub_gone").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PaddleApiError);
    expect((error as PaddleApiError).status).toBe(404);
  });

  it("reports a server-side failure as its own status, not as a missing record", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("upstream error", { status: 503 }),
    ));

    const error = await getSubscription("api-key", "sub_123").catch((err: unknown) => err);
    expect((error as PaddleApiError).status).toBe(503);
  });
});

describe("paddleApiBase", () => {
  // The key decides the host, so a sandbox key can never be sent to the live
  // API (which answers 403 to every billing call) and vice versa.
  it("routes a sandbox key to the sandbox host and a live key to the live host", () => {
    expect(paddleApiBase("pdl_sdbx_apikey_01abc_xyz")).toBe("https://sandbox-api.paddle.com");
    expect(paddleApiBase("pdl_live_apikey_01abc_xyz")).toBe("https://api.paddle.com");
  });
});

describe("getOrCreatePaddleCustomer", () => {
  function mockCustomers(
    lookups: Array<Array<{ id: string; email: string; name: string; status?: string }>>,
    createResponse: Response,
  ) {
    let lookup = 0;
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: { method?: string }) => {
      if ((init?.method ?? "GET") === "GET") {
        const data = lookups[Math.min(lookup++, lookups.length - 1)];
        return Promise.resolve(new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return Promise.resolve(createResponse.clone());
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const created = () => new Response(JSON.stringify({ data: { id: "ctm_new", email: "a@b.com", name: "A" } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  // `search` is fuzzy over id/name/email and paginated, so an exact match could
  // fall outside the page we read and we would create a duplicate Paddle
  // rejects. `email` is an exact filter, and archived customers still block a
  // create, so they have to be visible to the lookup.
  it("looks the customer up by exact email including archived rows", async () => {
    const fetchMock = mockCustomers([[{ id: "ctm_1", email: "A@B.com", name: "A" }]], created());

    await expect(getOrCreatePaddleCustomer("api-key", "a@b.com", "A")).resolves.toBe("ctm_1");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("email=a%40b.com");
    expect(url).toContain("status=active,archived");
    expect(url).not.toContain("search=");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prefers an active customer over an archived one with the same email", async () => {
    mockCustomers([[
      { id: "ctm_archived", email: "a@b.com", name: "A", status: "archived" },
      { id: "ctm_active", email: "a@b.com", name: "A", status: "active" },
    ]], created());

    await expect(getOrCreatePaddleCustomer("api-key", "a@b.com", "A")).resolves.toBe("ctm_active");
  });

  it("creates the customer when no exact match exists", async () => {
    mockCustomers([[]], created());

    await expect(getOrCreatePaddleCustomer("api-key", "a@b.com", "A")).resolves.toBe("ctm_new");
  });

  // Nothing is stored locally before this call, so an uncaught 409 would fail
  // the same user's checkout identically on every retry.
  it("recovers the existing customer when Paddle rejects the create as a duplicate", async () => {
    mockCustomers(
      [[], [{ id: "ctm_raced", email: "a@b.com", name: "A" }]],
      new Response("customer_already_exists", { status: 409 }),
    );

    await expect(getOrCreatePaddleCustomer("api-key", "a@b.com", "A")).resolves.toBe("ctm_raced");
  });

  it("rethrows when the duplicate still cannot be found", async () => {
    mockCustomers([[], []], new Response("customer_already_exists", { status: 409 }));

    await expect(getOrCreatePaddleCustomer("api-key", "a@b.com", "A"))
      .rejects.toBeInstanceOf(PaddleApiError);
  });
});

describe("findMatchingCheckoutTransaction", () => {
  const SEAT = "pri_01test000000000000000seat";
  const PRO = "pri_01test0000000000000000pro";

  function mockTransactions(data: unknown[]) {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("asks Paddle only for this customer's completable checkouts", async () => {
    const fetchMock = mockTransactions([]);

    await findMatchingCheckoutTransaction("api-key", { customerId: "ctm_1", priceId: PRO, quantity: 1 });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("customer_id=ctm_1");
    expect(url).toContain("status=draft%2Cready%2Cbilled%2Cpaid%2Ccompleted");
    expect(url).toContain("origin=api%2Cweb");
    // past_due is the dunning state of renewal payments, not of checkouts.
    expect(url).not.toContain("past_due");
    expect(url).toContain("collection_mode=automatic");
  });

  it("reuses the open transaction for the same plan and quantity", async () => {
    mockTransactions([{ id: "txn_open", status: "ready", origin: "api", created_at: new Date(Date.now() - 60_000).toISOString(), updated_at: new Date(Date.now() - 60_000).toISOString(), billed_at: null, items: [{ price: { id: SEAT }, quantity: 4 }] }]);

    await expect(findMatchingCheckoutTransaction("api-key", {
      customerId: "ctm_1", priceId: SEAT, quantity: 4,
    })).resolves.toEqual({ state: "open", transactionId: "txn_open" });
  });

  it("blocks a duplicate while a paid transaction waits for webhook projection", async () => {
    mockTransactions([{
      id: "txn_paid",
      status: "completed",
      origin: "api",
      created_at: new Date(Date.now() - 60_000).toISOString(),
      updated_at: new Date(Date.now() - 30_000).toISOString(),
      billed_at: new Date(Date.now() - 30_000).toISOString(),
      items: [{ price: { id: PRO }, quantity: 1 }],
    }]);

    await expect(findMatchingCheckoutTransaction("api-key", {
      customerId: "ctm_1", priceId: PRO, quantity: 1,
    })).resolves.toEqual({ state: "settling", transactionId: "txn_paid" });
  });

  // Paddle can collect on a saved payment method long after the draft was
  // minted: what matters is when the money moved, not when the checkout was
  // created.
  it("blocks a duplicate when an old checkout was paid moments ago", async () => {
    mockTransactions([{
      id: "txn_late_paid",
      status: "paid",
      origin: "api",
      created_at: new Date(Date.now() - 45 * 60_000).toISOString(),
      updated_at: new Date(Date.now() - 30_000).toISOString(),
      billed_at: null,
      items: [{ price: { id: PRO }, quantity: 1 }],
    }]);

    await expect(findMatchingCheckoutTransaction("api-key", {
      customerId: "ctm_1", priceId: PRO, quantity: 1,
    })).resolves.toEqual({ state: "settling", transactionId: "txn_late_paid" });
  });

  // A revision of customer details bumps updated_at without a new payment, so
  // billed_at — the actual payment time — wins where both exist.
  it("ages out on the payment time, not a later record revision", async () => {
    mockTransactions([{
      id: "txn_revised",
      status: "completed",
      origin: "api",
      created_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      billed_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      items: [{ price: { id: PRO }, quantity: 1 }],
    }]);

    await expect(findMatchingCheckoutTransaction("api-key", {
      customerId: "ctm_1", priceId: PRO, quantity: 1,
    })).resolves.toBeNull();
  });

  it("never blocks on a renewal charge that shares the plan and quantity", async () => {
    // The server-side origin filter should keep this row out of the response
    // entirely; asserting the classification too pins both layers.
    mockTransactions([{
      id: "txn_renewal",
      status: "completed",
      origin: "subscription_recurring",
      created_at: new Date(Date.now() - 60_000).toISOString(),
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      billed_at: new Date(Date.now() - 60_000).toISOString(),
      items: [{ price: { id: PRO }, quantity: 1 }],
    }]);

    await expect(findMatchingCheckoutTransaction("api-key", {
      customerId: "ctm_1", priceId: PRO, quantity: 1,
    })).resolves.toBeNull();
  });

  it("stops treating an aged-out paid checkout as settling so a lapsed subscriber can re-subscribe", async () => {
    // The reported regression: a canceled subscriber's last renewal-shaped
    // checkout sat in their history forever, answering 409 to every attempt.
    mockTransactions([{
      id: "txn_lapsed",
      status: "completed",
      origin: "api",
      created_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      updated_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      billed_at: null,
      items: [{ price: { id: PRO }, quantity: 1 }],
    }]);

    await expect(findMatchingCheckoutTransaction("api-key", {
      customerId: "ctm_1", priceId: PRO, quantity: 1,
    })).resolves.toBeNull();
  });

  it("skips an aged-out paid checkout and reuses the open one behind it", async () => {
    mockTransactions([
      {
        id: "txn_old",
        status: "completed",
        origin: "api",
        created_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        updated_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        billed_at: null,
        items: [{ price: { id: PRO }, quantity: 1 }],
      },
      { id: "txn_open", status: "ready", origin: "api", created_at: new Date(Date.now() - 60_000).toISOString(), updated_at: new Date(Date.now() - 60_000).toISOString(), billed_at: null, items: [{ price: { id: PRO }, quantity: 1 }] },
    ]);

    await expect(findMatchingCheckoutTransaction("api-key", {
      customerId: "ctm_1", priceId: PRO, quantity: 1,
    })).resolves.toEqual({ state: "open", transactionId: "txn_open" });
  });

  it("fails closed when a completed checkout carries no parseable payment time", async () => {
    mockTransactions([{
      id: "txn_broken",
      status: "completed",
      origin: "api",
      created_at: "not-a-timestamp",
      updated_at: "not-a-timestamp",
      billed_at: null,
      items: [{ price: { id: PRO }, quantity: 1 }],
    }]);

    await expect(findMatchingCheckoutTransaction("api-key", {
      customerId: "ctm_1", priceId: PRO, quantity: 1,
    })).resolves.toEqual({ state: "settling", transactionId: "txn_broken" });
  });

  // Switching plan, or an Organization whose seat count moved, is a different
  // purchase and needs its own transaction.
  it("ignores an open transaction for a different plan or quantity", async () => {
    mockTransactions([
      { id: "txn_pro", status: "ready", origin: "api", created_at: new Date(Date.now() - 60_000).toISOString(), updated_at: new Date(Date.now() - 60_000).toISOString(), billed_at: null, items: [{ price: { id: PRO }, quantity: 1 }] },
      { id: "txn_seats", status: "ready", origin: "api", created_at: new Date(Date.now() - 60_000).toISOString(), updated_at: new Date(Date.now() - 60_000).toISOString(), billed_at: null, items: [{ price: { id: SEAT }, quantity: 2 }] },
    ]);

    await expect(findMatchingCheckoutTransaction("api-key", {
      customerId: "ctm_1", priceId: SEAT, quantity: 4,
    })).resolves.toBeNull();
  });

  it("never reuses a multi-item transaction", async () => {
    mockTransactions([{
      id: "txn_bundle",
      status: "ready",
      origin: "api",
      created_at: new Date(Date.now() - 60_000).toISOString(),
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      billed_at: null,
      items: [{ price: { id: SEAT }, quantity: 4 }, { price: { id: PRO }, quantity: 1 }],
    }]);

    await expect(findMatchingCheckoutTransaction("api-key", {
      customerId: "ctm_1", priceId: SEAT, quantity: 4,
    })).resolves.toBeNull();
  });
});

describe("resolveCheckoutTransaction", () => {
  const PRO = "pri_01test0000000000000000pro";

  function mockPaddle(subscriptions: unknown[], transactions: unknown[]) {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const body = JSON.stringify({
        data: String(url).includes("/subscriptions?") ? subscriptions : transactions,
      });
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("asks Paddle only for this customer's entitled subscriptions", async () => {
    const fetchMock = mockPaddle([], []);

    await resolveCheckoutTransaction("api-key", { customerId: "ctm_1", priceId: PRO, quantity: 1 });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/subscriptions?");
    expect(url).toContain("customer_id=ctm_1");
    expect(url).toContain("status=active%2Ctrialing");
  });

  // The local projection lags Paddle: a completed checkout can already have
  // become a subscription there while our webhook is in flight. Minting another
  // payable transaction then would let a saved payment method be charged twice,
  // so the live subscription list is read before any transaction reuse or
  // creation.
  it("blocks a new payable transaction while an entitled subscription already exists at Paddle", async () => {
    const fetchMock = mockPaddle([{ id: "sub_live", status: "active" }], []);

    await expect(resolveCheckoutTransaction("api-key", {
      customerId: "ctm_1", priceId: PRO, quantity: 1,
    })).resolves.toEqual({ state: "pending" });

    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("reuses the open transaction once no entitled subscription exists", async () => {
    mockPaddle(
      [],
      [{ id: "txn_open", status: "ready", origin: "api", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), billed_at: null, items: [{ price: { id: PRO }, quantity: 1 }] }],
    );

    await expect(resolveCheckoutTransaction("api-key", {
      customerId: "ctm_1", priceId: PRO, quantity: 1,
    })).resolves.toEqual({ state: "open", transactionId: "txn_open" });
  });

  it("answers pending while a just-paid transaction settles", async () => {
    mockPaddle(
      [],
      [{
        id: "txn_paid",
        status: "completed",
        origin: "api",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        billed_at: new Date().toISOString(),
        items: [{ price: { id: PRO }, quantity: 1 }],
      }],
    );

    await expect(resolveCheckoutTransaction("api-key", {
      customerId: "ctm_1", priceId: PRO, quantity: 1,
    })).resolves.toEqual({ state: "pending" });
  });

  it("leaves a fresh transaction to be created when nothing blocks it", async () => {
    mockPaddle([], []);

    await expect(resolveCheckoutTransaction("api-key", {
      customerId: "ctm_1", priceId: PRO, quantity: 1,
    })).resolves.toEqual({ state: "none" });
  });
});

type PaddleCheckoutEvent = {
  name?: string;
  type?: string;
  code?: string;
  detail?: string;
  errors?: Array<{ field?: string; message?: string }>;
  data?: {
    transaction_id?: string;
  };
};

interface PaddleCheckoutCompletion {
  transactionId: string | null;
}

type CheckoutCompletionListener = (completion: PaddleCheckoutCompletion) => void;

const checkoutCompletionListeners = new Set<CheckoutCompletionListener>();

export function subscribeToPaddleCheckoutCompletion(
  listener: CheckoutCompletionListener,
): () => void {
  checkoutCompletionListeners.add(listener);
  return () => checkoutCompletionListeners.delete(listener);
}

type PaddleCheckoutOpenOptions = {
  transactionId: string;
  settings?: {
    displayMode?: "overlay" | "inline";
    variant?: "multi-page" | "one-page";
  };
};

type PaddleGlobal = {
  Initialize: (opts: {
    token: string;
    eventCallback?: (event: PaddleCheckoutEvent) => void;
  }) => void;
  Environment?: { set?: (env: string) => void };
  Checkout: {
    open: (opts: PaddleCheckoutOpenOptions) => void;
  };
};

declare global {
  interface Window {
    Paddle?: PaddleGlobal;
    __orbmeetPaddleScriptPromise?: Promise<void>;
    __orbmeetPaddleInitialized?: boolean;
  }
}

type OpenCheckoutOptions = {
  transactionId: string;
};

const PADDLE_SCRIPT_URL = "https://cdn.paddle.com/paddle/v2/paddle.js";
const PADDLE_SCRIPT_TIMEOUT_MS = 15_000;

export function buildCheckoutOpenOptions({
  transactionId,
}: OpenCheckoutOptions): PaddleCheckoutOpenOptions {
  return {
    settings: {
      displayMode: "overlay",
    },
    transactionId,
  };
}

function getPaddle(): PaddleGlobal {
  const paddle = window.Paddle;
  if (!paddle) throw new Error("Paddle.js is unavailable");
  return paddle;
}

async function loadPaddleJs(): Promise<void> {
  if (typeof window === "undefined") return;
  if (window.Paddle) return;

  const existingPromise = window.__orbmeetPaddleScriptPromise;
  if (existingPromise) {
    await existingPromise;
    return;
  }

  window.__orbmeetPaddleScriptPromise = new Promise<void>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${PADDLE_SCRIPT_URL}"]`);
    const script = existingScript ?? document.createElement("script");
    let settled = false;
    const timeout = setTimeout(() => fail("Timed out loading Paddle.js"), PADDLE_SCRIPT_TIMEOUT_MS);
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const fail = (message = "Failed to load Paddle.js") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      script.remove();
      reject(new Error(message));
    };

    script.addEventListener("load", succeed, { once: true });
    script.addEventListener("error", () => fail(), { once: true });
    if (!existingScript) {
      script.src = PADDLE_SCRIPT_URL;
      document.head.appendChild(script);
    }
  });

  try {
    await window.__orbmeetPaddleScriptPromise;
  } catch (error) {
    window.__orbmeetPaddleScriptPromise = undefined;
    throw error;
  }
}

function logCheckoutEvent(event: PaddleCheckoutEvent): void {
  if (event.name === "checkout.completed") {
    const completion = { transactionId: event.data?.transaction_id ?? null };
    for (const listener of checkoutCompletionListeners) listener(completion);
    return;
  }
  if (
    event.name === "checkout.error" ||
    event.name === "checkout.payment.error" ||
    event.name === "checkout.warning"
  ) {
    console.error("Paddle checkout event:", event);
  }
}

/**
 * Point Paddle.js at the environment its own token belongs to.
 *
 * Sandbox client-side tokens are prefixed `test_`, live ones `live_`. Deriving
 * the checkout environment from the token — as the server derives its API host
 * from the API key — removes a separate `PADDLE_ENVIRONMENT` setting that could
 * disagree with the credential sitting next to it. That mismatch is silent and
 * expensive in both directions: a sandbox token sent to the live checkout, or a
 * live token used while the server creates sandbox transactions.
 */
export function initializePaddleClient(
  paddle: PaddleGlobal,
  clientToken: string,
): void {
  if (clientToken.startsWith("test_")) {
    if (!paddle.Environment?.set) {
      throw new Error("Paddle.js cannot select the sandbox environment");
    }
    paddle.Environment.set("sandbox");
  }

  paddle.Initialize({
    token: clientToken,
    eventCallback: logCheckoutEvent,
  });
}

export async function getPaddleClient(): Promise<PaddleGlobal> {
  if (typeof window === "undefined") {
    throw new Error("Paddle checkout is only available in the browser");
  }

  await loadPaddleJs();

  const paddle = getPaddle();
  if (window.__orbmeetPaddleInitialized) return paddle;

  const clientToken = (import.meta.env as Record<string, string>).VITE_PADDLE_CLIENT_TOKEN;

  if (!clientToken) {
    throw new Error("Paddle client token is not configured");
  }

  initializePaddleClient(paddle, clientToken);

  window.__orbmeetPaddleInitialized = true;
  return paddle;
}

export async function openPaddleCheckout({
  transactionId,
}: OpenCheckoutOptions): Promise<void> {
  const paddle = await getPaddleClient();

  paddle.Checkout.open(buildCheckoutOpenOptions({ transactionId }));
}

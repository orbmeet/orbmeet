/**
 * Paddle catalog price ids are ULID-suffixed and always `pri_`-prefixed.
 * Anything else is a typo or a leftover placeholder, and treating it as
 * configured is worse than treating it as absent: the id reaches Paddle, which
 * rejects the transaction with a 400 the user sees as a generic failure. A
 * runtime shape check turns that into the honest "Plan pricing not configured"
 * 503.
 */
const PADDLE_PRICE_ID_PATTERN = /^pri_[0-9a-z]+$/i;

/** Return a usable catalog price id, never a placeholder or a malformed one. */
export function configuredPaddlePriceId(value?: string): string | undefined {
  const priceId = value?.trim();
  if (!priceId || !PADDLE_PRICE_ID_PATTERN.test(priceId)) return undefined;
  return priceId;
}

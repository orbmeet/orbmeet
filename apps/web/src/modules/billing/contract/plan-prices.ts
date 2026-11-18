/** A price as checkout will charge it: an amount in the currency's major unit (5 = $5, 600 = ৳600). */
export interface PlanPrice {
  /** Lower-case ISO 4217 code, as Polar writes it. */
  currency: string;
  amount: number;
}

/** What a visitor will pay, in the currency their checkout will use. */
export interface PlanPrices {
  pro: PlanPrice;
  /** One Organization license (seat) a month. */
  organizationSeat: PlanPrice;
  /** Whether tax is added on top at checkout (US, Canada, India) rather than included. */
  taxAddedAtCheckout: boolean;
}

/**
 * The prices in the Polar organization's default currency: what pages show
 * before the visitor's own prices load, and what the server falls back to
 * when Polar cannot be read. Checkout always charges Polar's actual prices.
 */
export const DEFAULT_PLAN_PRICES: PlanPrices = {
  pro: { currency: "usd", amount: 5 },
  organizationSeat: { currency: "usd", amount: 10 },
  taxAddedAtCheckout: false,
};

/**
 * A price for display: the currency's own symbol where it is unambiguous
 * (€5, £4, ৳600, ₹450), the qualified one where a bare "$" would mislead
 * (CA$7, A$8), and no decimals for a whole amount.
 */
export function formatPlanPrice({ currency, amount }: PlanPrice): string {
  const code = currency.toUpperCase();
  const whole = Number.isInteger(amount);
  const format = (currencyDisplay: "narrowSymbol" | "symbol") =>
    new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      currencyDisplay,
      minimumFractionDigits: whole ? 0 : undefined,
      maximumFractionDigits: whole ? 0 : undefined,
    }).format(amount);
  const narrow = format("narrowSymbol");
  return code !== "USD" && narrow.includes("$") ? format("symbol") : narrow;
}

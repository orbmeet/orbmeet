// The Worker's Cron Triggers, as scheduled.server.ts dispatches on them.
// cloudflare.config.ts declares the same expressions written out — it may not
// import from src/ (see its header) — and build/config/cloudflare.test.ts
// fails if the two disagree, so a schedule edited in one place cannot leave
// the other unable to match it.

/** Every minute: media node health, cleanup, schedule notifications, quiet meetings. */
export const MINUTELY_CRON = "* * * * *";
/** Daily: authentication cleanup, stranded deletions, Paddle reconciliation, webhook receipts. */
export const DAILY_CRON = "0 3 * * *";

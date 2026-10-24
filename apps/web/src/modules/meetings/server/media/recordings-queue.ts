/**
 * The queue R2 reports uploaded recordings on (see recordings.server.ts). The
 * bucket raises the events; the queue and the bucket's rule are created once,
 * the rule naming the queue by the id `queues create` returns:
 *
 *   cf queues create --queue-name orbmeet-recordings
 *   cf queues edit <queue-id> --settings-message-retention-period 1209600
 *   cf r2 buckets event-notifications update <queue-id> --bucket-name <bucket> \
 *     --rules '[{"actions":["PutObject","CopyObject","CompleteMultipartUpload"],
 *               "prefix":"meetings/","suffix":".mp4",
 *               "description":"Register uploaded meeting recordings"}]'
 *
 * cloudflare.config.ts declares the consumer with the name and retry count
 * written out, since it may not import from src/; build/config/cloudflare.test.ts
 * fails if they differ from the ones here.
 *
 * The rule is not in any configuration this repository deploys, so nothing
 * here can show it exists. The daily `registerUnregisteredRecordings` sweep
 * registers what the queue never did and logs each one as an error, which is
 * how a missing rule (or a message the queue gave up on) shows itself.
 */
export const RECORDINGS_QUEUE_NAME = "orbmeet-recordings";

/** How long the queue keeps a message (set on the queue): the most Queues allows. */
export const RECORDINGS_QUEUE_RETENTION_SECONDS = 14 * 24 * 60 * 60;

/**
 * Deliveries after the first. With `recordingRetryDelaySeconds`, the last
 * comes after about thirteen days, inside the queue's retention: a message
 * that outlives it is dropped however many retries it has left.
 */
export const RECORDING_UPLOAD_MAX_RETRIES = 23;

/** A minute after the first failure, doubling, at most the day Queues allows. */
export function recordingRetryDelaySeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.min(attempts - 1, 20), 24 * 60 * 60);
}

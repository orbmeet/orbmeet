import { useRef, useCallback } from "react";

interface TokenBucketState {
  tokens: number;
  lastRefillAt: number;
}

/**
 * Client-side token bucket rate limiter.
 * Uses refs (not state) to avoid re-renders on token consumption.
 *
 * @param capacity - Maximum tokens in the bucket
 * @param refillRatePerSec - Tokens added per second
 * @returns consume function that returns true if the action is allowed
 */
export function useTokenBucket(capacity: number, refillRatePerSec: number) {
  const bucketRef = useRef<TokenBucketState | null>(null);

  const consume = useCallback((): boolean => {
    const now = Date.now();
    const bucket = bucketRef.current ?? {
      tokens: capacity,
      lastRefillAt: now,
    };
    bucketRef.current = bucket;

    // Refill tokens based on elapsed time
    const elapsedSec = Math.max(0, (now - bucket.lastRefillAt) / 1000);
    const refilled = elapsedSec * refillRatePerSec;
    bucket.tokens = Math.min(capacity, bucket.tokens + refilled);
    bucket.lastRefillAt = now;

    if (bucket.tokens < 1) {
      return false;
    }

    bucket.tokens -= 1;
    return true;
  }, [capacity, refillRatePerSec]);

  return { consume };
}

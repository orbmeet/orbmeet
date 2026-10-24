/**
 * Deterministic string → bucket-index hash shared by every "always the same
 * color for the same name" feature (space gradients, room gradients, ...).
 * Keep the algorithm stable — changing it reshuffles colors that users have
 * already learned to recognize.
 */
export function hashStringToIndex(input: string, bucketCount: number): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % bucketCount;
}

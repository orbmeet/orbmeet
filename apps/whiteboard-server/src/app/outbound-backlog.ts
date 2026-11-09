/**
 * Bytes queued for slow readers across the whole node, which a limit per socket
 * cannot bound: 16 MiB for each of a room's 500 sockets is twice the memory of
 * the container. Past this budget the sockets furthest behind are dropped, and
 * they resync when they reconnect, rather than the node running out of memory
 * and taking every board with it.
 */
const MAX_NODE_BUFFERED_BYTES = 1024 * 1024 * 1024;

/** A socket with less than this queued is keeping up, and costs little to keep. */
export const SHED_MIN_BUFFERED_BYTES = 1024 * 1024;

/** Sends are frequent and summing every socket is not, so the total is reused this long. */
const SAMPLE_INTERVAL_MS = 200;

export class OutboundBacklog {
  private total = 0;
  private sampledAt = Number.NEGATIVE_INFINITY;
  private readonly sockets: () => Iterable<{ bufferedAmount: number }>;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(
    sockets: () => Iterable<{ bufferedAmount: number }>,
    maxBytes = MAX_NODE_BUFFERED_BYTES,
    now: () => number = Date.now,
  ) {
    this.sockets = sockets;
    this.maxBytes = maxBytes;
    this.now = now;
  }

  /** Whether a socket with `bufferedBytes` queued should go to protect the node. */
  shouldShed(bufferedBytes: number): boolean {
    if (bufferedBytes < SHED_MIN_BUFFERED_BYTES) return false;
    const now = this.now();
    if (now - this.sampledAt >= SAMPLE_INTERVAL_MS) {
      this.sampledAt = now;
      this.total = 0;
      for (const socket of this.sockets()) this.total += socket.bufferedAmount;
    }
    return this.total > this.maxBytes;
  }

  /** A dropped socket's bytes are gone, so the next one is not shed on a stale total. */
  release(bufferedBytes: number): void {
    this.total = Math.max(0, this.total - bufferedBytes);
  }
}

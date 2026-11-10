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

/** Sends are frequent and summing every socket is not, so a check runs this often at most. */
const SAMPLE_INTERVAL_MS = 200;

export class OutboundBacklog<Socket extends { bufferedAmount: number }> {
  private sampledAt = Number.NEGATIVE_INFINITY;
  private readonly sockets: () => Iterable<Socket>;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(
    sockets: () => Iterable<Socket>,
    maxBytes = MAX_NODE_BUFFERED_BYTES,
    now: () => number = Date.now,
  ) {
    this.sockets = sockets;
    this.maxBytes = maxBytes;
    this.now = now;
  }

  /**
   * The sockets to drop to bring the node back within budget, furthest behind
   * first; empty while it is within budget or a check ran moments ago.
   */
  socketsToShed(): Socket[] {
    const now = this.now();
    if (now - this.sampledAt < SAMPLE_INTERVAL_MS) return [];
    this.sampledAt = now;

    const queued = Array.from(this.sockets(), (socket) => ({ socket, bytes: socket.bufferedAmount }));
    let excess = queued.reduce((total, { bytes }) => total + bytes, -this.maxBytes);
    if (excess <= 0) return [];

    const shed: Socket[] = [];
    for (const { socket, bytes } of queued.sort((a, b) => b.bytes - a.bytes)) {
      if (excess <= 0 || bytes < SHED_MIN_BUFFERED_BYTES) break;
      shed.push(socket);
      excess -= bytes;
    }
    return shed;
  }
}

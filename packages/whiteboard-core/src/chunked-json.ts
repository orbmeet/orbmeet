import { WHITEBOARD_CONFIG } from "./config.ts";

const CHUNK_RE = /^(\d+)_(.*)$/s;
const MAX_MESSAGE_CHUNKS = 4096;
const MAX_ASSEMBLED_BYTES = WHITEBOARD_CONFIG.MAX_CLIENT_MESSAGE_BYTES;
const UTF8_ENCODER = new TextEncoder();

/**
 * A chunked message outgrew the bytes it was allowed to assemble into.
 *
 * `exceedsMessageMaximum` tells the two limits apart: past the per-message
 * maximum the sender broke the protocol, but under it the message only
 * outgrew a tighter allowance the caller passed for the moment (a room's
 * shared assembly budget, say), which says nothing about the sender.
 */
export class AssembledMessageTooLargeError extends Error {
  readonly exceedsMessageMaximum: boolean;

  constructor(exceedsMessageMaximum: boolean) {
    super("Assembled message too large");
    this.exceedsMessageMaximum = exceedsMessageMaximum;
    this.name = "AssembledMessageTooLargeError";
  }
}

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

export class JsonMessageAssembler {
  private state: "idle" | {
    chunksReceived: string[];
    totalChunks: number;
    bytes: number;
  } = "idle";

  get isAssembling(): boolean {
    return this.state !== "idle";
  }

  get bufferedBytes(): number {
    return this.state === "idle" ? 0 : this.state.bytes;
  }

  reset(): void {
    this.state = "idle";
  }

  handleMessage(
    msg: string,
    maxAssembledBytes = MAX_ASSEMBLED_BYTES,
  ): { data: unknown; stringified: string } | { error: Error } | null {
    const byteLimit = Math.max(0, Math.min(MAX_ASSEMBLED_BYTES, maxAssembledBytes));
    if (msg.startsWith("{")) {
      const error = this.state === "idle" ? undefined : new Error("Unexpected non-chunk message");
      this.state = "idle";
      if (error) return { error };
      try {
        return { data: JSON.parse(msg) as unknown, stringified: msg };
      } catch (parseError) {
        return { error: parseError instanceof Error ? parseError : new Error(String(parseError)) };
      }
    }

    const match = CHUNK_RE.exec(msg);
    if (!match) {
      this.state = "idle";
      return { error: new Error(`Invalid chunk: ${JSON.stringify(msg.slice(0, 20) + "...")}`) };
    }

    const numChunksRemaining = Number(match[1]);
    const data = match[2] ?? "";
    if (this.state === "idle") {
      const totalChunks = numChunksRemaining + 1;
      if (totalChunks < 1 || totalChunks > MAX_MESSAGE_CHUNKS) {
        return { error: new Error("Chunk count out of range") };
      }
      const bytes = utf8ByteLength(data);
      if (bytes > byteLimit) {
        return { error: new AssembledMessageTooLargeError(bytes > MAX_ASSEMBLED_BYTES) };
      }
      this.state = { chunksReceived: [data], totalChunks, bytes };
    } else {
      this.state.chunksReceived.push(data);
      this.state.bytes += utf8ByteLength(data);
      if (this.state.bytes > byteLimit) {
        const exceedsMessageMaximum = this.state.bytes > MAX_ASSEMBLED_BYTES;
        this.state = "idle";
        return { error: new AssembledMessageTooLargeError(exceedsMessageMaximum) };
      }
      if (numChunksRemaining !== this.state.totalChunks - this.state.chunksReceived.length) {
        this.state = "idle";
        return { error: new Error("Chunks received in wrong order") };
      }
    }

    if (this.state.chunksReceived.length !== this.state.totalChunks) return null;
    try {
      const stringified = this.state.chunksReceived.join("");
      return { data: JSON.parse(stringified) as unknown, stringified };
    } catch (error) {
      return { error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      this.state = "idle";
    }
  }
}

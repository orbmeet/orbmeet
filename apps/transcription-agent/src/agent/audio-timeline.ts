const MAX_TIMELINE_HISTORY_MS = 120_000;
const TIMELINE_ANCHOR_INTERVAL_MS = 30_000;
const TIMELINE_DISCONTINUITY_MS = 5;

export interface TimelineChunk {
  capturedAt: number;
  durationMs: number;
  trackSid: string;
}

/** Where a point of the sent audio came from. */
export interface CapturePoint {
  capturedAt: number;
  trackSid: string;
}

interface RecordedChunk {
  streamStartMs: number;
  streamEndMs: number;
  capturedAt: number;
  trackSid: string;
}

interface Anchor {
  streamOffsetMs: number;
  capturedAt: number;
  trackSid: string;
}

/**
 * Maps one Deepgram connection's audio offsets back to the capture clock.
 *
 * Deepgram times a result from the start of the audio sent on its connection.
 * The audio sent is not continuous capture: a reconnect backlog, dropped
 * frames and a microphone swap all make the two clocks diverge. Every chunk
 * sent is recorded here, so an offset resolves to when that audio was
 * actually captured, and from which track. One timeline belongs to one
 * connection; a new connection starts a new one.
 */
export class AudioTimeline {
  private readonly chunks: RecordedChunk[] = [];
  private readonly anchors: Anchor[] = [];
  private lastRecorded: RecordedChunk | null = null;
  private streamDurationMs = 0;

  record(chunk: TimelineChunk): void {
    const streamStartMs = this.streamDurationMs;
    this.streamDurationMs += chunk.durationMs;
    const recorded: RecordedChunk = {
      streamStartMs,
      streamEndMs: this.streamDurationMs,
      capturedAt: chunk.capturedAt,
      trackSid: chunk.trackSid,
    };
    this.chunks.push(recorded);
    const previous = this.lastRecorded;
    const previousCapturedEnd = previous
      ? previous.capturedAt + (previous.streamEndMs - previous.streamStartMs)
      : null;
    const lastAnchor = this.anchors.at(-1);
    if (
      !lastAnchor ||
      previousCapturedEnd === null ||
      previous?.trackSid !== chunk.trackSid ||
      Math.abs(chunk.capturedAt - previousCapturedEnd) > TIMELINE_DISCONTINUITY_MS ||
      streamStartMs - lastAnchor.streamOffsetMs >= TIMELINE_ANCHOR_INTERVAL_MS
    ) {
      this.anchors.push({ streamOffsetMs: streamStartMs, capturedAt: chunk.capturedAt, trackSid: chunk.trackSid });
    }
    this.lastRecorded = recorded;

    const oldestUsefulOffset = this.streamDurationMs - MAX_TIMELINE_HISTORY_MS;
    while (this.chunks.length > 1 && this.chunks[1].streamEndMs < oldestUsefulOffset) {
      this.chunks.shift();
    }
    // Keep only the last anchor before the retained chunks plus those inside
    // them: enough to place a delayed result without growing for the life of
    // the connection.
    const earliestChunkOffset = this.chunks[0]?.streamStartMs ?? streamStartMs;
    let firstAnchorToKeep = 0;
    while (
      firstAnchorToKeep + 1 < this.anchors.length &&
      this.anchors[firstAnchorToKeep + 1].streamOffsetMs <= earliestChunkOffset
    ) {
      firstAnchorToKeep += 1;
    }
    if (firstAnchorToKeep > 0) this.anchors.splice(0, firstAnchorToKeep);
  }

  /** The capture time and track of a stream offset, or null when no audio was sent there. */
  at(streamOffsetMs: number): CapturePoint | null {
    if (!Number.isFinite(streamOffsetMs) || this.chunks.length === 0) return null;
    if (streamOffsetMs < this.chunks[0].streamStartMs) {
      let anchor = this.anchors[0];
      if (!anchor || streamOffsetMs < anchor.streamOffsetMs) return null;
      for (const candidate of this.anchors) {
        if (candidate.streamOffsetMs > streamOffsetMs) break;
        anchor = candidate;
      }
      return {
        capturedAt: Math.round(anchor.capturedAt + (streamOffsetMs - anchor.streamOffsetMs)),
        trackSid: anchor.trackSid,
      };
    }

    let low = 0;
    let high = this.chunks.length - 1;
    let match = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (this.chunks[middle].streamStartMs <= streamOffsetMs) {
        match = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (match === -1) return null;
    const chunk = this.chunks[match];
    const offsetWithinChunk = Math.max(
      0,
      Math.min(streamOffsetMs - chunk.streamStartMs, chunk.streamEndMs - chunk.streamStartMs),
    );
    return { capturedAt: Math.round(chunk.capturedAt + offsetWithinChunk), trackSid: chunk.trackSid };
  }
}

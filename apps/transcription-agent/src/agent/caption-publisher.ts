import { CAPTION_TOPIC, encodeCaptionStreamAttributes } from "@orbmeet/caption-protocol";
import { sleep, withDeadline } from "../abort.js";
import type { CaptionUpdate } from "./transcript-assembler.js";
import { logWarn } from "../log.js";

const PUBLISH_TIMEOUT_MS = 5_000;
const MAX_PENDING_SEGMENTS = 32;

interface CaptionWriter {
  write(text: string): Promise<void>;
  close(): Promise<void>;
}

/** The part of the agent's LiveKit participant captions are sent through. */
export interface CaptionTransport {
  streamText(options: {
    topic: string;
    senderIdentity: string;
    attributes: Record<string, string>;
  }): Promise<CaptionWriter>;
}

interface PendingCaption {
  update: CaptionUpdate;
  revision: number;
}

/**
 * Sends live captions, newest first and at most once per segment update.
 *
 * Captions are lossy by contract, so this never holds anything else up and
 * never grows without bound. Each segment has one pending slot: a newer update
 * replaces an unsent older one, so a stalled connection sends the latest text
 * when it recovers rather than working through every interim it missed. When
 * too many segments are waiting, the oldest waiting update is dropped; a later
 * update of that segment still goes out, and a segment that has none left is
 * closed by its receivers when it goes quiet.
 */
export class CaptionPublisher {
  private readonly pending = new Map<string, PendingCaption>();
  private readonly revisions = new Map<string, number>();
  private loop: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly options: {
      transport: () => CaptionTransport | undefined;
      senderIdentity: string;
      publishTimeoutMs?: number;
      maxPendingSegments?: number;
    },
  ) {}

  offer(update: CaptionUpdate): void {
    if (this.closed) return;
    const revision = (this.revisions.get(update.segmentId) ?? 0) + 1;
    // A final is a segment's last update; nothing more will be numbered for it.
    if (update.isFinal) this.revisions.delete(update.segmentId);
    else this.revisions.set(update.segmentId, revision);
    this.pending.set(update.segmentId, { update, revision });

    const maxPending = this.options.maxPendingSegments ?? MAX_PENDING_SEGMENTS;
    // Only the waiting update is dropped. Its segment keeps counting: receivers
    // may already hold one of its earlier revisions, and keep only a higher one.
    while (this.pending.size > maxPending) {
      this.pending.delete(this.pending.keys().next().value!);
    }
    this.loop ??= this.drain().finally(() => {
      this.loop = null;
    });
  }

  /** Stop accepting captions and give the ones already offered up to `graceMs` to go out. */
  async close(graceMs: number): Promise<void> {
    this.closed = true;
    const loop = this.loop;
    if (loop) await Promise.race([loop, sleep(graceMs)]);
    this.pending.clear();
    this.revisions.clear();
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      const [segmentId, caption] = this.pending.entries().next().value!;
      this.pending.delete(segmentId);
      try {
        await withDeadline(
          this.publish(caption),
          this.options.publishTimeoutMs ?? PUBLISH_TIMEOUT_MS,
          "LiveKit caption publish timed out",
        );
      } catch (error) {
        logWarn("Failed to publish a live caption", { segmentId, error });
      }
    }
  }

  private async publish({ update, revision }: PendingCaption): Promise<void> {
    const transport = this.options.transport();
    if (!transport) return;
    const writer = await transport.streamText({
      topic: CAPTION_TOPIC,
      senderIdentity: this.options.senderIdentity,
      attributes: encodeCaptionStreamAttributes({
        trackId: update.trackSid,
        segmentId: update.segmentId,
        isFinal: update.isFinal,
        language: update.language,
        revision,
      }),
    });
    // Closed however the write ends, even after the deadline stopped waiting
    // for it: an unclosed stream stays open on every receiver.
    try {
      if (update.text) await writer.write(update.text);
    } finally {
      await writer.close();
    }
  }
}

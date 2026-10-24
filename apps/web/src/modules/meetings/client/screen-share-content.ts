import type { LocalVideoTrack } from "livekit-client";
import { detectEngine, getPlatformEnvironment } from "@/lib/browser-capabilities";

/**
 * What a shared screen is showing, as far as its encoder should care:
 * `detail` — slides, documents, code: keep every letter sharp and let the
 * frame rate give; `motion` — a video playing: keep it moving and let the
 * resolution give.
 */
export type ScreenContent = "detail" | "motion";

/** How often the capture rate is read. */
const SAMPLE_MS = 1000;
/** Captured frames per second at or above which the screen is moving. */
const MOVING_FPS = 12;
/** At or below which it has settled. */
const STILL_FPS = 4;
/** Seconds in a row it must keep moving before the share turns to motion: a scroll is not a video. */
const MOVING_SAMPLES = 3;
/** Seconds in a row it must stay settled before the share turns back to detail. */
const STILL_SAMPLES = 5;

/**
 * The next state, from the capture rates read so far, newest last. Each side
 * needs a run of readings, so a burst of scrolling or a paused video does not
 * flip the encoder back and forth.
 */
export function nextScreenContent(current: ScreenContent, rates: readonly number[]): ScreenContent {
  if (current === "detail") {
    const recent = rates.slice(-MOVING_SAMPLES);
    return recent.length === MOVING_SAMPLES && recent.every((fps) => fps >= MOVING_FPS) ? "motion" : "detail";
  }
  const recent = rates.slice(-STILL_SAMPLES);
  return recent.length === STILL_SAMPLES && recent.every((fps) => fps <= STILL_FPS) ? "detail" : "motion";
}

/**
 * Keeps a published screen share's encoder suited to what it shows, without
 * asking the presenter.
 *
 * Chrome captures a screen only as it changes: still slides arrive a few
 * frames a second, a playing video at its own rate. That rate is in the
 * sender's `media-source` stats, so reading it once a second tells a video
 * from a document at no cost — no pixels are looked at, and it keeps working
 * while the presenter's own tab is in the background. Other browsers may
 * capture at a fixed rate, which would read as motion all the time, so the
 * share is left as published there.
 *
 * Stops by itself once the track ends, which unpublishing does.
 */
export function adaptScreenShareToContent(track: LocalVideoTrack): void {
  if (detectEngine(getPlatformEnvironment()) !== "chromium") return;
  let content: ScreenContent = "detail";
  const rates: number[] = [];
  const timer = setInterval(() => {
    if (track.mediaStreamTrack.readyState === "ended") {
      clearInterval(timer);
      return;
    }
    void captureRate(track).then((fps) => {
      if (fps === null) return;
      rates.push(fps);
      if (rates.length > STILL_SAMPLES) rates.shift();
      const next = nextScreenContent(content, rates);
      if (next === content) return;
      content = next;
      track.mediaStreamTrack.contentHint = next;
      void track.setDegradationPreference(next === "motion" ? "maintain-framerate" : "maintain-resolution");
    });
  }, SAMPLE_MS);
}

/** Frames a second the screen is being captured at, or null before the browser reports it. */
async function captureRate(track: LocalVideoTrack): Promise<number | null> {
  const stats = await track.sender?.getStats().catch(() => undefined);
  if (!stats) return null;
  for (const report of stats.values()) {
    if (report.type === "media-source" && report.kind === "video" && typeof report.framesPerSecond === "number") {
      return report.framesPerSecond;
    }
  }
  return null;
}

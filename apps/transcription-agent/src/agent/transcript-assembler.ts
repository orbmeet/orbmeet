import { MAX_CAPTION_TEXT_LENGTH } from "@orbmeet/caption-protocol";
import { codePointBoundary } from "@orbmeet/primitives";

const MAX_UTTERANCE_MS = 30_000;

/** What a Deepgram connection reports, already placed on the capture clock. */
export type TranscriptEvent =
  | {
      kind: "words";
      text: string;
      /** Deepgram committed this text; it will not change. */
      isFinal: boolean;
      /** Deepgram detected the end of the utterance (`speech_final`). */
      endpoint: boolean;
      /** The response to a Finalize request. */
      fromFinalize: boolean;
      /** Capture time of the audio the words start and end in, when it could be placed. */
      startedAt: number | null;
      endedAt: number | null;
      trackSid: string | null;
      language: string;
      /** Receiver-clock arrival time: the stand-in for audio that cannot be placed. */
      receivedAt: number;
    }
  /** Deepgram's word-gap boundary (`UtteranceEnd`). */
  | { kind: "utterance-end" }
  /**
   * The utterance is interrupted: the connection ended, the microphone was
   * muted and Deepgram did not answer Finalize, or the job is stopping.
   */
  | { kind: "interrupt" };

/** A committed piece of the durable transcript. */
export interface TranscriptFinal {
  segmentId: string;
  text: string;
  startedAt: number;
  language: string;
}

/** One update to a live caption segment. */
export interface CaptionUpdate {
  segmentId: string;
  trackSid: string;
  text: string;
  isFinal: boolean;
  language: string;
}

interface OpenUtterance {
  id: string;
  /** Which caption part of the utterance is open. */
  part: number;
  /** How many durable finals the utterance has produced. */
  finals: number;
  /** Committed text of the open caption part. */
  committed: string;
  /** Deepgram's current hypothesis for what follows `committed`. */
  interim: string;
  /** Whether the open part has been captioned, and so must be finalized. */
  shown: boolean;
  /**
   * Deepgram flagged the end of the utterance on a hypothesis. The utterance
   * closes with the final that commits it, even if that final is not flagged.
   */
  endpointSeen: boolean;
  startedAt: number;
  trackSid: string;
  language: string;
}

export interface AssemblerState {
  nextUtterance: number;
  lastTrackSid: string | null;
  open: OpenUtterance | null;
}

export interface AssemblerStep {
  state: AssemblerState;
  finals: TranscriptFinal[];
  captions: CaptionUpdate[];
}

export function initialAssemblerState(): AssemblerState {
  return { nextUtterance: 0, lastTrackSid: null, open: null };
}

/**
 * Fold one transcript event into the utterance being spoken.
 *
 * Pure: the same events always yield the same finals and captions. Two
 * contracts come out of it, and they do not wait on each other:
 *
 * - `finals` are the durable record. Every text Deepgram commits becomes one
 *   final, exactly once, stamped with when its audio was captured.
 * - `captions` are the live view, lossy by design. Every segment opened is
 *   also finalized. A normal close shows what Deepgram committed; an
 *   interrupted one keeps what the room last saw.
 *
 * `idPrefix` makes ids unique across jobs; the utterance counter makes them
 * unique within one, across every connection the job makes.
 */
export function reduceTranscript(state: AssemblerState, event: TranscriptEvent, idPrefix: string): AssemblerStep {
  const finals: TranscriptFinal[] = [];
  const captions: CaptionUpdate[] = [];

  if (event.kind === "interrupt") {
    return { state: close(state, captions, "interrupted"), finals, captions };
  }
  if (event.kind === "utterance-end") {
    return { state: close(state, captions, "committed"), finals, captions };
  }

  const text = event.text.trim();
  let next: AssemblerState = event.trackSid ? { ...state, lastTrackSid: event.trackSid } : state;

  if (text && !next.open) {
    const trackSid = event.trackSid ?? next.lastTrackSid;
    // Words whose audio cannot be traced to a track cannot be captioned, since
    // a caption names its microphone. What Deepgram committed is still the
    // record, so it is journaled all the same.
    if (!trackSid) {
      if (event.isFinal) {
        finals.push({
          segmentId: `${idPrefix}:u${next.nextUtterance}:f0`,
          text,
          startedAt: event.startedAt ?? event.receivedAt,
          language: event.language,
        });
      }
      return { state: { ...next, nextUtterance: next.nextUtterance + 1 }, finals, captions };
    }
    next = {
      ...next,
      nextUtterance: next.nextUtterance + 1,
      open: {
        id: `${idPrefix}:u${next.nextUtterance}`,
        part: 0,
        finals: 0,
        committed: "",
        interim: "",
        shown: false,
        endpointSeen: false,
        startedAt: event.startedAt ?? event.receivedAt,
        trackSid,
        language: event.language,
      },
    };
  }
  const current = next.open;
  if (!current) return { state: next, finals, captions };
  const open = event.endpoint && !current.endpointSeen ? { ...current, endpointSeen: true } : current;

  if (event.isFinal) {
    let utterance = open;
    if (text) {
      finals.push({
        segmentId: `${utterance.id}:f${utterance.finals}`,
        text,
        startedAt: event.startedAt ?? event.receivedAt,
        language: event.language,
      });
      utterance = { ...utterance, finals: utterance.finals + 1, committed: joinText(utterance.committed, text), interim: "" };
      // A caption has a size limit; a long utterance continues in a new part.
      while (utterance.committed.length >= MAX_CAPTION_TEXT_LENGTH) {
        const { head, tail } = splitCaptionText(utterance.committed);
        captions.push(caption(utterance, head, true));
        utterance = { ...utterance, part: utterance.part + 1, committed: tail, shown: false };
      }
    } else {
      utterance = { ...utterance, interim: "" };
    }
    next = { ...next, open: utterance };
    const tooLong = event.endedAt !== null && event.endedAt - utterance.startedAt >= MAX_UTTERANCE_MS;
    if (utterance.endpointSeen || event.fromFinalize || tooLong) {
      return { state: close(next, captions, "committed"), finals, captions };
    }
    if (utterance.committed) {
      captions.push(caption(utterance, utterance.committed, false));
      next = { ...next, open: { ...utterance, shown: true } };
    }
    return { state: next, finals, captions };
  }

  // A wordless endpoint closes the utterance its earlier finals committed.
  if (event.endpoint && !text) {
    return { state: close({ ...next, open }, captions, "committed"), finals, captions };
  }
  if (!text) return { state: { ...next, open }, finals, captions };
  const utterance = { ...open, interim: text, shown: true };
  captions.push(caption(utterance, splitCaptionText(visibleText(utterance)).head, false));
  return { state: { ...next, open: utterance }, finals, captions };
}

function close(state: AssemblerState, captions: CaptionUpdate[], show: "committed" | "interrupted"): AssemblerState {
  const open = state.open;
  if (!open) return state;
  // A final with no text withdraws the segment: Deepgram committed nothing.
  const text = show === "committed" ? open.committed : visibleText(open);
  if (open.shown || text) captions.push(caption(open, splitCaptionText(text).head, true));
  return { ...state, open: null };
}

function caption(utterance: OpenUtterance, text: string, isFinal: boolean): CaptionUpdate {
  return {
    segmentId: utterance.part === 0 ? utterance.id : `${utterance.id}.${utterance.part}`,
    trackSid: utterance.trackSid,
    text,
    isFinal,
    language: utterance.language,
  };
}

function visibleText(utterance: OpenUtterance): string {
  return joinText(utterance.committed, utterance.interim);
}

function joinText(prefix: string, suffix: string): string {
  const left = prefix.trim();
  const right = suffix.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

/** Split at a nearby word boundary without ever cutting a UTF-16 surrogate pair. */
export function splitCaptionText(text: string): { head: string; tail: string } {
  if (text.length <= MAX_CAPTION_TEXT_LENGTH) return { head: text, tail: "" };

  let splitAt = codePointBoundary(text, MAX_CAPTION_TEXT_LENGTH);

  const earliestWordBoundary = Math.floor(MAX_CAPTION_TEXT_LENGTH * 0.75);
  for (let index = splitAt - 1; index >= earliestWordBoundary; index -= 1) {
    if (/\s/u.test(text[index] ?? "")) {
      splitAt = index;
      break;
    }
  }

  return { head: text.slice(0, splitAt).trimEnd(), tail: text.slice(splitAt).trimStart() };
}

import type { AssistantAudienceRequest, AssistantEntry, AssistantRun } from "@orbmeet/whiteboard-core/assistant";

/**
 * Orb, the board's assistant, as the meeting sees it.
 *
 * Orb lives on the board — it reads the page someone is looking at and draws
 * through their browser — so it is here only while the board is. It answers
 * to the same people who could see the question: everyone in the room, two
 * people in a private thread, or one person in their own thread with Orb.
 * Each answer sits in its thread in the order things happened.
 */
export interface MeetingAssistant {
  /** False when the server has no model to answer with. */
  available: boolean;
  /** Connected and able to take a question. */
  live: boolean;
  /** Orb may draw for this viewer: they can write on the board. Anyone else gets words. */
  canDraw: boolean;
  /** The room's conversation and this viewer's private ones. */
  entries: readonly AssistantEntry[];
  /** Every run this viewer can see; at most one per conversation. */
  runs: readonly AssistantRun[];
  /** Resolves to an error to show, or null once the question is taken. */
  prompt(text: string, options?: { audience?: AssistantAudienceRequest; said?: string }): Promise<string | null>;
  cancel(runId: string): void;
  mayCancel(run: AssistantRun): boolean;
  /** Brings what Orb drew into view on this viewer's board. */
  showShapes(pageId: string, ids: readonly string[]): void;
  /** Takes back what Orb drew; an error to show, or null. */
  removeShapes(ids: readonly string[]): string | null;
}

export const ORB_NAME = "Orb";

const MENTION = /^@orb(?![\p{L}\p{N}_])[\s,:;-]*/iu;

/**
 * The question in a message addressed to Orb — "@Orb is this right?" — or
 * null when the message is not addressed to Orb. A bare "@Orb" is an empty
 * question.
 */
export function orbQuestion(message: string): string | null {
  const trimmed = message.trimStart();
  const match = MENTION.exec(trimmed);
  return match ? trimmed.slice(match[0].length).trim() : null;
}

/** Whether what is being typed could still become "@Orb", so the mention can be offered. */
export function isOrbMentionPrefix(input: string): boolean {
  const typed = input.trimStart().toLowerCase();
  return typed.length > 0 && typed.length <= 4 && "@orb".startsWith(typed);
}

/** The composer's text once the mention is chosen: "@Orb " and nothing typed is lost. */
export function withOrbMention(input: string): string {
  const question = orbQuestion(input);
  if (question !== null) return `@${ORB_NAME} ${question}`;
  return isOrbMentionPrefix(input) ? `@${ORB_NAME} ` : `@${ORB_NAME} ${input.trimStart()}`;
}

/** What "catch me up" asks, in the asker's own thread with Orb. */
export const CATCH_UP_QUESTION = "Catch me up on the last 10 minutes.";

/** How far back "what was said lately" reaches when Orb is asked. */
const ORB_SAID_WINDOW_MS = 10 * 60_000;
const ORB_SAID_MAX_LENGTH = 20_000;

interface SaidSegment {
  userName: string;
  text: string;
  isFinal: boolean;
  startedAt: number;
}

/**
 * What was said in the last ten minutes, for Orb, as "Name: words" lines — one
 * per turn, so a speaker's run of segments reads as one line. When it is too
 * long, the oldest words go first.
 */
export function recentlySaid(segments: readonly SaidSegment[], now: number, windowMs = ORB_SAID_WINDOW_MS): string {
  const lines: { name: string; words: string[] }[] = [];
  for (const segment of segments) {
    if (!segment.isFinal || now - segment.startedAt > windowMs) continue;
    const text = segment.text.trim();
    if (!text) continue;
    const last = lines.at(-1);
    if (last?.name === segment.userName) last.words.push(text);
    else lines.push({ name: segment.userName, words: [text] });
  }
  const said = lines.map((line) => `${line.name}: ${line.words.join(" ")}`).join("\n");
  return said.length > ORB_SAID_MAX_LENGTH ? said.slice(said.length - ORB_SAID_MAX_LENGTH) : said;
}

/** An answer of Orb's, put to the room by someone who saw it in private. */
export function sharedOrbAnswer(text: string, maxLength: number): string {
  const prefix = `${ORB_NAME} said: “`;
  const room = maxLength - prefix.length - 1;
  const body = text.trim().length > room ? `${text.trim().slice(0, room - 1)}…` : text.trim();
  return `${prefix}${body}”`;
}

import { ORB_NAME } from "./orb";

/**
 * Tips that teach Orb, one at a time, in the Chat.
 *
 * Like an editor's startup tips rather than a tour: one short line under the
 * box you write in, a different one each time the Chat opens and after each
 * message you send, never one that does not apply to you. An example in a tip
 * can be pressed, which puts it in the box to send or change.
 */
export interface OrbTip {
  id: string;
  /** The sentence, up to the example. */
  text: string;
  /** Something to ask Orb, written out: pressing it puts it in the box. */
  example?: string;
}

export interface OrbTipContext {
  /** Orb draws for this viewer: they can write on the board. */
  canDraw: boolean;
  /** The meeting is transcribing, so "catch me up" has something to go on. */
  transcribing: boolean;
  /** There is a private thread with Orb to point to. */
  orbThread: boolean;
  /** There is someone to write to privately. */
  privateChats: boolean;
  /** The command palette's shortcut, where there is a keyboard to press it on. */
  paletteShortcut?: string;
}

export function orbTips(context: OrbTipContext): OrbTip[] {
  const tips: (OrbTip | false)[] = [
    // Drawing first: it is what shows people what Orb is for.
    context.canDraw
      // An example that stands on its own: "a flowchart of this page" failed on
      // the empty page a new board opens with, which is when the tip shows.
      ? { id: "draw", text: `${ORB_NAME} can draw on the board. Try `, example: `@${ORB_NAME} draw a flowchart: sign up, verify email, first meeting` }
      : {
          id: "draw-ask",
          text: `${ORB_NAME} draws for anyone with the pen. Ask to edit on the board, then try `,
          example: `@${ORB_NAME} draw `,
        },
    { id: "check", text: `Ask ${ORB_NAME} to check work: `, example: `@${ORB_NAME} is step 3 right?` },
    { id: "select", text: `Ask about one part of the board: select it, then press Ask ${ORB_NAME} beside it.` },
    context.transcribing && {
      id: "catch-up",
      text: `Missed something? “${ORB_NAME}, catch me up” sums up the last 10 minutes, for you alone.`,
    },
    context.orbThread && {
      id: "orb-thread",
      text: `The ${ORB_NAME} tab is just you and ${ORB_NAME}. Nobody else sees what you ask there.`,
    },
    context.privateChats && {
      id: "private",
      text: `In a private chat, @${ORB_NAME} answers just the two of you.`,
    },
    context.canDraw && { id: "undo", text: `Don’t want what ${ORB_NAME} drew? Press Undo under its answer.` },
    context.paletteShortcut !== undefined && {
      id: "palette",
      text: `Press ${context.paletteShortcut} and type a question to ask ${ORB_NAME} from anywhere. Everyone sees the answer.`,
    },
    { id: "page", text: `${ORB_NAME} reads the page you’re on. Turn to a page, then try `, example: `@${ORB_NAME} explain this page` },
  ];
  return tips.filter((tip): tip is OrbTip => tip !== false);
}

/** Questions for your own thread with Orb, all answered in words: it never draws there. */
const ORB_QUESTIONS: readonly { text: string; needsSpeech?: boolean }[] = [
  { text: "What did I miss?", needsSpeech: true },
  { text: "Explain this page in simple words" },
  { text: "Is the step I selected right?" },
  { text: "Quiz me on this page" },
  { text: "Give me a hint, not the answer" },
  { text: "Summarize what we've covered so far", needsSpeech: true },
  { text: "What do the words on this page mean?" },
  { text: "Check my working on this page" },
  { text: "Give me a similar problem to try" },
  { text: "What's a good question to ask next?" },
];

/** How many questions the Orb tab offers at once. */
const ORB_QUESTIONS_SHOWN = 4;

/** The `set`th handful of questions; those about what was said only while there is something said. */
export function orbQuestionIdeas(set: number, transcribing: boolean): string[] {
  const questions = ORB_QUESTIONS.filter((question) => transcribing || !question.needsSpeech);
  return Array.from(
    { length: ORB_QUESTIONS_SHOWN },
    (_, offset) => questions[(set * ORB_QUESTIONS_SHOWN + offset) % questions.length].text,
  );
}

const TURN_KEY = "orbmeet.orbTips.turn";
const OFF_KEY = "orbmeet.orbTips.off";

/**
 * Which tip is next, remembered on this device so the next meeting starts
 * where this one left off. Storage can throw on access, so it is read and
 * written behind a non-throwing boundary, like every preference in the room.
 */
export function loadOrbTipTurn(): number {
  if (typeof window === "undefined") return 0;
  try {
    const turn = Number.parseInt(window.localStorage.getItem(TURN_KEY) ?? "0", 10);
    return Number.isFinite(turn) && turn >= 0 ? turn : 0;
  } catch {
    return 0;
  }
}

export function saveOrbTipTurn(turn: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TURN_KEY, String(turn));
  } catch {
    // A tip is never worth an error.
  }
}

/** Whether this person has turned the tips off, on this device. */
export function loadOrbTipsOff(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(OFF_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveOrbTipsOff(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OFF_KEY, "1");
  } catch {
    // Still off for this meeting: the caller holds it in state.
  }
}

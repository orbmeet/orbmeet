import * as v from "valibot";
import type { CanvasShape } from "./canvas-shapes.ts";
import type { CanvasToolName } from "./canvas-tools.ts";
import type { AssistantLookedAt } from "./looked-at.ts";

// The assistant's wire contract between the sync server and every browser.
//
// The server owns the conversation and runs the model. A browser posts
// requests to `WHITEBOARD_SYNC_ROUTES.assistant` and receives events over the
// board socket. Board edits are tool calls the server sends to the browser
// that asked; that browser applies them and posts the result back.

export const ASSISTANT_EVENTS = {
  /**
   * The room's whole conversation, sent when it is cleared. (A GET answers
   * with a snapshot too, of everything its asker may see.)
   */
  SNAPSHOT: "assistant.snapshot",
  /** One entry was added or changed. */
  ENTRY: "assistant.entry",
  /** A run started or ended. */
  RUN: "assistant.run",
  /** Sent only to the requester's connection: carry out a canvas tool. */
  TOOL_CALL: "assistant.tool-call",
} as const;

export const MAX_ASSISTANT_PROMPT_LENGTH = 4_000;
/** A JPEG data URL; the client scales its screenshots down to fit. */
export const MAX_ASSISTANT_SCREENSHOT_LENGTH = 480 * 1024;
export const MAX_ASSISTANT_CONTEXT_SHAPES = 200;
export const MAX_ASSISTANT_TOOL_RESULT_TEXT_LENGTH = 64 * 1024;
/** Prompt and tool-result bodies carry a screenshot and a shape list. */
export const MAX_ASSISTANT_REQUEST_BYTES = 1024 * 1024;

/**
 * Who a conversation is for. The room's is everyone's. A private one is its
 * members' alone — one person and Orb, or two people and Orb — and nothing of
 * it reaches anyone else, the recording included. Orb answers to the same
 * people who could see the question.
 */
export type AssistantAudience = { kind: "room" } | { kind: "private"; /** User ids, sorted; one or two. */ members: string[] };

export const ROOM_AUDIENCE: AssistantAudience = { kind: "room" };

/** A private audience of these people, in its one canonical form. */
export function privateAudience(userIds: readonly string[]): AssistantAudience {
  return { kind: "private", members: [...new Set(userIds)].sort() };
}

/** A stable key for an audience. An entry or run without one is the room's. */
export function audienceKey(audience: AssistantAudience | undefined): string {
  return !audience || audience.kind === "room" ? "room" : `private:${audience.members.join("|")}`;
}

/**
 * One line of the conversation. `at` is when the server first recorded it, in
 * epoch milliseconds, so a host can place the conversation among its own
 * events; a later update to an entry keeps its first time.
 */
export type AssistantEntry = { id: string; at: number; /** Absent: the room's. */ audience?: AssistantAudience } & (
  | {
      kind: "prompt";
      author: string;
      /** The asker's whiteboard identity. */
      authorId: string;
      text: string;
      /** What went with the question, shown under its answer. */
      lookedAt?: AssistantLookedAt;
    }
  | { kind: "reply"; text: string; done: boolean }
  | {
      kind: "tool";
      tool: CanvasToolName;
      label: string;
      status: "running" | "done" | "failed";
      /** The page it acted on, and the shapes it made and changed there (simple ids), once done. */
      pageId?: string;
      created?: string[];
      changed?: string[];
    }
  | { kind: "notice"; text: string }
);

export interface AssistantRun {
  id: string;
  requesterUserId: string;
  requesterName: string;
  /** Absent: the room's. */
  audience?: AssistantAudience;
}

export interface AssistantSnapshot {
  /** False when this server has no model configured. */
  available: boolean;
  /** Every conversation this viewer is in: the room's, and their private ones. */
  entries: AssistantEntry[];
  /** The room's run. */
  run: AssistantRun | null;
  /** Every run this viewer may see, the room's included. */
  runs?: AssistantRun[];
}

export type AssistantEvent =
  | { type: typeof ASSISTANT_EVENTS.SNAPSHOT; snapshot: AssistantSnapshot }
  | { type: typeof ASSISTANT_EVENTS.ENTRY; entry: AssistantEntry }
  | {
      type: typeof ASSISTANT_EVENTS.RUN;
      /** The run now going on in `audience`, or null once it ended. */
      run: AssistantRun | null;
      /** Absent: the room's. */
      audience?: AssistantAudience;
    }
  | {
      type: typeof ASSISTANT_EVENTS.TOOL_CALL;
      runId: string;
      callId: string;
      /** The page the request was made on; the call acts there even if the requester moved on. */
      pageId: string;
      tool: CanvasToolName;
      args: unknown;
    };

// ─── Requests ─────────────────────────────────────────────────────────────────

const id = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{8,128}$/));
/** A shape's id without its "shape:" prefix, as the assistant names shapes. */
const shapeRef = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const screenshot = v.pipe(
  v.string(),
  v.startsWith("data:image/jpeg;base64,"),
  v.maxLength(MAX_ASSISTANT_SCREENSHOT_LENGTH),
);

/** What the requester's browser could see when they asked. */
/** How many pages the outline describes, and how much of each page's words. */
export const MAX_ASSISTANT_OUTLINE_PAGES = 100;
export const MAX_ASSISTANT_OUTLINE_TEXT_LENGTH = 400;
const MAX_ASSISTANT_NAME_LENGTH = 100;

const PageOutlineSchema = v.object({
  pageNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  text: v.pipe(v.string(), v.maxLength(MAX_ASSISTANT_OUTLINE_TEXT_LENGTH)),
  drawings: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Anything that is neither words nor ink, by kind: "image ×2, pdf-page". */
  objects: v.pipe(v.string(), v.maxLength(200)),
});

const PageContextSchema = v.object({
  pageId: v.pipe(v.string(), v.startsWith("shape:"), v.maxLength(128)),
  pageNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  pageCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
  width: v.pipe(v.number(), v.minValue(1)),
  height: v.pipe(v.number(), v.minValue(1)),
  // Built by the client from live records and passed to the model as JSON, so
  // it is bounded here rather than re-validated field by field.
  shapes: v.pipe(v.array(v.custom<CanvasShape>((value) => typeof value === "object" && value !== null)), v.maxLength(MAX_ASSISTANT_CONTEXT_SHAPES)),
  selectedShapeIds: v.pipe(v.array(v.pipe(v.string(), v.maxLength(64))), v.maxLength(MAX_ASSISTANT_CONTEXT_SHAPES)),
  screenshot: v.optional(screenshot),
  /**
   * The presenter the asker is following, and the page they are on. Optional:
   * a board nobody presents has no answer to "which page are we on" beyond
   * the asker's own.
   */
  following: v.optional(v.object({
    presenterName: v.pipe(v.string(), v.maxLength(MAX_ASSISTANT_NAME_LENGTH)),
    pageNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  })),
  /**
   * Every page, briefly: its words and how many drawings and objects it has.
   * Without it the assistant saw only the page it was asked from, and answered
   * "what have we covered" by guessing at the rest.
   */
  outline: v.optional(v.pipe(v.array(PageOutlineSchema), v.maxLength(MAX_ASSISTANT_OUTLINE_PAGES))),
});
export type AssistantPageContext = v.InferOutput<typeof PageContextSchema>;
export type AssistantPageOutline = v.InferOutput<typeof PageOutlineSchema>;

/** What was said in the meeting lately, as "Name: words" lines; enough for "catch me up". */
export const MAX_ASSISTANT_SAID_LENGTH = 24_000;

const userId = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

/** Who will see the question and the answer: the room, just the asker, or the asker and one other person. */
const AudienceRequestSchema = v.variant("kind", [
  v.object({ kind: v.literal("room") }),
  v.object({ kind: v.literal("private"), with: v.optional(userId) }),
]);
export type AssistantAudienceRequest = v.InferOutput<typeof AudienceRequestSchema>;

export const AssistantRequestSchema = v.variant("type", [
  v.object({
    type: v.literal("prompt"),
    text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_ASSISTANT_PROMPT_LENGTH)),
    page: PageContextSchema,
    /** Absent: the room. */
    audience: v.optional(AudienceRequestSchema),
    said: v.optional(v.pipe(v.string(), v.maxLength(MAX_ASSISTANT_SAID_LENGTH))),
  }),
  v.object({
    type: v.literal("tool-result"),
    runId: id,
    callId: id,
    ok: v.boolean(),
    text: v.pipe(v.string(), v.maxLength(MAX_ASSISTANT_TOOL_RESULT_TEXT_LENGTH)),
    screenshot: v.optional(screenshot),
    /** What the call made and changed on the page, so the conversation can show it or take it back. */
    shapes: v.optional(
      v.object({
        created: v.optional(v.pipe(v.array(shapeRef), v.maxLength(MAX_ASSISTANT_CONTEXT_SHAPES))),
        changed: v.optional(v.pipe(v.array(shapeRef), v.maxLength(MAX_ASSISTANT_CONTEXT_SHAPES))),
      }),
    ),
  }),
  /** Stops a run: the one named, or else the room's. */
  v.object({ type: v.literal("cancel"), runId: v.optional(id) }),
  v.object({ type: v.literal("clear") }),
]);
export type AssistantRequest = v.InferOutput<typeof AssistantRequestSchema>;
export type AssistantToolResult = Extract<AssistantRequest, { type: "tool-result" }>;

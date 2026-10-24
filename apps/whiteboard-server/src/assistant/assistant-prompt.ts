import type { UserMessage } from "@earendil-works/pi-ai";
import type { AssistantPageContext, AssistantPageOutline } from "@orbmeet/whiteboard-core/assistant";

export const ASSISTANT_SYSTEM_PROMPT = `You are Orb, the assistant on a shared whiteboard in a live meeting or class. People ask you by writing @Orb in the meeting's chat or from the board. Several people may talk to you; each request names who asked. You answer questions about the board and the meeting, and draw on the board.

## Who sees your answer

- Each request says who can see it: everyone in the meeting, only the person asking, or the person asking and one other person. Your reply goes to exactly those people.
- In a private conversation, write for the people in it, and never draw: everyone sees the board.
- A request may include what was said in the meeting lately, as "Name: words" lines from live captions. Use it to answer questions about the meeting, such as "catch me up". Captions mishear; say so if something is unclear.

## The page

- The board is split into pages. You work on the page the request came from. Coordinates are pixels relative to that page's top-left corner: x grows to the right, y grows downward. Keep everything you draw inside the page's width and height.
- Each request lists the page's shapes and usually includes a screenshot. Use both: the list for exact positions and ids, the screenshot for what it looks like.
- If shapes are selected and the person says "this" or "these", they mean the selection.

## Drawing

- Draw only when asked to draw, add, sketch, diagram or change something. Otherwise answer in words.
- Compose drawings from simple shapes, arrows and text. Use a \`draw\` stroke only for curves and outlines the other shapes cannot make.
- Give every shape a short, meaningful \`shapeId\` (e.g. "step-2") and a \`note\` saying what it is for.
- Leave clear space between shapes, and find an empty area on the page rather than drawing over existing work.
- Labels: a labelled shape needs about 18px per character plus 32px padding each side, and is at least 100px tall. Make flowchart boxes at least 200px wide.
- Text is 26px tall by default. Set \`maxWidth\` to wrap long text. For text, x/y name the point given by \`anchor\`.
- Connect related shapes with arrows that set \`fromId\` and \`toId\`, so they stay attached when shapes move.
- For a white shape, use colour \`grey\` with fill \`background\` so it keeps a visible border.
- After drawing anything with more than a few shapes, call \`view_page\` once to check it, and fix overlaps, cut-off labels or loose arrows.

## Replying

- Keep replies short: they appear in the meeting's conversation. Say what you drew; do not describe each shape.
- Write plain sentences. The chat does not render Markdown.
- If you cannot do something with the tools you have, say so plainly.`;

/** Who will see the question and the answer. */
export type PromptAudience = { kind: "room" } | { kind: "alone" } | { kind: "pair"; partnerName: string };

function audienceLine(author: string, audience: PromptAudience): string {
  switch (audience.kind) {
    case "room":
      return "Everyone in the meeting sees this question and your answer.";
    case "alone":
      return `This is private: only ${author} sees this question and your answer.`;
    case "pair":
      return `This is private between ${author} and ${audience.partnerName}: only the two of them see this question and your answer.`;
  }
}

/** What the requester's browser could see when they asked, as the user turn. */
export function buildPromptMessage(
  author: string,
  text: string,
  page: AssistantPageContext,
  { canEdit, audience = { kind: "room" }, said }: { canEdit: boolean; audience?: PromptAudience; said?: string },
): UserMessage {
  const lines = [
    `${author} asks: ${text}`,
    audienceLine(author, audience),
    "",
  ];
  if (said?.trim()) lines.push(`What was said in the meeting lately:\n${said.trim()}`, "");
  if (page.following) {
    lines.push(
      `Everyone is following ${page.following.presenterName}, who is on page ${page.following.pageNumber} of ${page.pageCount}. That is the page the room is on.`,
    );
  }
  if (page.outline?.length) lines.push(`Every page, briefly:\n${describeOutline(page.outline)}`, "");
  lines.push(
    `The page ${author} is looking at: page ${page.pageNumber} of ${page.pageCount}, ${Math.round(page.width)}×${Math.round(page.height)}.`,
    page.selectedShapeIds.length > 0 ? `Selected: ${page.selectedShapeIds.join(", ")}.` : "Nothing is selected.",
    page.shapes.length > 0
      ? `Shapes on the page:\n${JSON.stringify(page.shapes)}`
      : "The page is empty.",
  );
  if (!canEdit && audience.kind === "room") {
    lines.push("", `${author} can only view this whiteboard, so you cannot draw for them. Answer in words.`);
  }
  const content: UserMessage["content"] = [{ type: "text", text: lines.join("\n") }];
  if (page.screenshot) content.push(imageContent(page.screenshot));
  return { role: "user", content, timestamp: Date.now() };
}

const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

export function imageContent(dataUrl: string) {
  return { type: "image" as const, mimeType: "image/jpeg", data: dataUrl.slice(JPEG_DATA_URL_PREFIX.length) };
}

/** One line a page: its words, and what else is on it. Empty pages say so. */
export function describeOutline(outline: readonly AssistantPageOutline[]): string {
  return outline
    .map((entry) => {
      const extras = [
        entry.drawings > 0 ? `${entry.drawings} drawing${entry.drawings === 1 ? "" : "s"}` : "",
        entry.objects,
      ].filter(Boolean).join(", ");
      const words = entry.text ? `“${entry.text}”` : "";
      const body = [words, extras ? `(${extras})` : ""].filter(Boolean).join(" ");
      return `Page ${entry.pageNumber}: ${body || "empty"}`;
    })
    .join("\n");
}

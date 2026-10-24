import { describe, expect, it } from "vitest";
import type { AssistantPageContext } from "@orbmeet/whiteboard-core/assistant";

import { buildPromptMessage, describeOutline } from "./assistant-prompt";

const page: AssistantPageContext = {
  pageId: "shape:page4",
  pageNumber: 4,
  pageCount: 7,
  width: 1600,
  height: 1000,
  shapes: [],
  selectedShapeIds: [],
};

function textOf(message: ReturnType<typeof buildPromptMessage>): string {
  const first = message.content[0];
  return typeof first === "object" && "text" in first ? first.text : "";
}

describe("buildPromptMessage", () => {
  it("names the page the room is on when the asker follows a presenter", () => {
    const text = textOf(
      buildPromptMessage("Priya", "What have we covered?", { ...page, following: { presenterName: "Atiq", pageNumber: 4 } }, { canEdit: false }),
    );
    expect(text).toContain("Everyone is following Atiq, who is on page 4 of 7.");
    expect(text).toContain("The page Priya is looking at: page 4 of 7");
  });

  it("describes every page, so questions about the whole board have something to stand on", () => {
    const text = textOf(
      buildPromptMessage(
        "Priya",
        "What have we covered?",
        {
          ...page,
          outline: [
            { pageNumber: 1, text: "Warm-up", drawings: 1, objects: "" },
            { pageNumber: 2, text: "x + 3 = 9", drawings: 0, objects: "" },
            { pageNumber: 5, text: "", drawings: 0, objects: "image" },
            { pageNumber: 6, text: "", drawings: 0, objects: "" },
          ],
        },
        { canEdit: true },
      ),
    );
    expect(text).toContain("Every page, briefly:");
    expect(text).toContain("Page 2: “x + 3 = 9”");
    expect(text).toContain("Page 6: empty");
  });

  it("says nothing about following when nobody is presenting", () => {
    expect(textOf(buildPromptMessage("Atiq", "Hi", page, { canEdit: true }))).not.toContain("following");
  });
});

describe("describeOutline", () => {
  it("counts drawings and lists objects beside a page's words", () => {
    expect(describeOutline([{ pageNumber: 3, text: "Practice", drawings: 2, objects: "image ×2" }])).toBe(
      "Page 3: “Practice” (2 drawings, image ×2)",
    );
  });
});

import { describe, expect, it } from "vitest";

import { describeLookedAt, lookedAtFromRequest } from "./looked-at.ts";
import type { AssistantPageContext } from "./protocol.ts";

const page: AssistantPageContext = {
  pageId: "shape:page-4",
  pageNumber: 4,
  pageCount: 7,
  width: 800,
  height: 1100,
  shapes: [],
  selectedShapeIds: [],
};

describe("lookedAtFromRequest", () => {
  it("keeps only what was sent, never the page's content", () => {
    expect(
      lookedAtFromRequest(
        {
          ...page,
          screenshot: "data:image/jpeg;base64,AAAA",
          following: { presenterName: "Atiq", pageNumber: 4 },
          outline: Array.from({ length: 7 }, (_, index) => ({ pageNumber: index + 1, text: "x", drawings: 0, objects: "" })),
        },
        "Atiq: let us start",
      ),
    ).toEqual({ pageNumber: 4, pageCount: 7, following: "Atiq", outlinePages: 7, picture: true, said: true });
  });

  it("leaves out what did not go with the question", () => {
    expect(lookedAtFromRequest(page, "  ")).toEqual({ pageNumber: 4, pageCount: 7 });
  });
});

describe("describeLookedAt", () => {
  it("names the page, whose it was, the outline and what was said", () => {
    expect(describeLookedAt({ pageNumber: 4, pageCount: 7, following: "Atiq", outlinePages: 7, said: true })).toBe(
      "Looked at page 4 of 7 (Atiq’s page), an outline of all 7 pages and what was said lately.",
    );
  });

  it("says the page on a one-page board, with no outline of it", () => {
    expect(describeLookedAt({ pageNumber: 1, pageCount: 1, outlinePages: 1 })).toBe("Looked at the page.");
  });

  it("joins two things with and", () => {
    expect(describeLookedAt({ pageNumber: 2, pageCount: 3, said: true })).toBe(
      "Looked at page 2 of 3 and what was said lately.",
    );
  });
});

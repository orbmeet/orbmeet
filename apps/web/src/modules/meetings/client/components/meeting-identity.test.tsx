import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MeetingIdentity } from "./meeting-identity";

const meetingClock = { startedAtMs: Date.now(), skewMs: 0 } as never;

const baseProps = {
  code: "vyf-fadu-gvw",
  meetingClock,
  isRecording: false,
};

describe("MeetingIdentity", () => {
  it("leaves the head count to the room, and offers the link only when it can copy it", () => {
    const markup = renderToStaticMarkup(<MeetingIdentity {...baseProps} />);
    expect(markup).not.toMatch(/\bpeople\b|\bperson\b/);
    expect(markup).not.toContain("<button");

    const withCopy = renderToStaticMarkup(<MeetingIdentity {...baseProps} onCopyLink={() => {}} />);
    expect(withCopy).toContain('aria-label="Copy meeting link"');
    // A recorder's render shows the room; it has nothing to press.
    const recorder = renderToStaticMarkup(<MeetingIdentity {...baseProps} onCopyLink={() => {}} readOnly />);
    expect(recorder).not.toContain("<button");
  });

  it("shows a named meeting's code beside its name: it is what people type to join", () => {
    const markup = renderToStaticMarkup(<MeetingIdentity {...baseProps} meetingTitle="Algebra study group" />);
    expect(markup).toMatch(/<h1[^>]*>Algebra study group<\/h1>/);
    expect(markup).toContain("vyf-fadu-gvw");
  });

  it("tells everyone when the meeting is locked", () => {
    const open = renderToStaticMarkup(<MeetingIdentity {...baseProps} />);
    const locked = renderToStaticMarkup(<MeetingIdentity {...baseProps} isLocked />);

    expect(open).not.toContain("Locked");
    expect(locked).toContain("Locked");
    expect(locked).toContain("new people wait to be let in");
  });

  it("leads a Space meeting with the Space's name, and does not repeat it", () => {
    const markup = renderToStaticMarkup(<MeetingIdentity {...baseProps} spaceName="Algebra study group" />);

    expect(markup).toMatch(/<h1[^>]*>Algebra study group<\/h1>/);
    expect(markup.split("Algebra study group").length - 1).toBe(2); // heading text + its title attribute
  });

  it("falls back to the code when the meeting has no title and no Space", () => {
    const markup = renderToStaticMarkup(<MeetingIdentity {...baseProps} />);
    expect(markup).toMatch(/<h1[^>]*>vyf-fadu-gvw<\/h1>/);
  });

  it("names what a recorder render shows", () => {
    const markup = renderToStaticMarkup(<MeetingIdentity {...baseProps} readOnly surfaceActive />);
    expect(markup).toContain("Whiteboard");
  });
});

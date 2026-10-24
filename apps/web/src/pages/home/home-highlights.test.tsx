import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StillToDo, Today } from "./home-highlights";

const feeds = vi.hoisted(() => ({ upcoming: vi.fn(), followUps: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useSuspenseInfiniteQuery: feeds.upcoming, useQuery: feeds.followUps }));
vi.mock("@/app/query-client/queries/meetings", () => ({
  myUpcomingMeetingSchedulesQueryOptions: () => ({}),
  myOpenFollowUpsQueryOptions: () => ({}),
}));
vi.mock("@/modules/transcripts/client/follow-up-list", () => ({
  FollowUpList: ({ items }: { items: Array<{ id: string; text: string; detail?: ReactNode }> }) => (
    <ul>{items.map((item) => <li key={item.id}>{item.text} — {item.detail}</li>)}</ul>
  ),
}));
vi.mock("@/modules/scheduling/client/schedule-meeting-dialog", () => ({ ScheduleMeetingDialog: () => null }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

const schedule = {
  id: "next", state: "upcoming", code: "abc-defg-hij", startsAt: "2026-09-08T04:30:00.000Z",
  timeZone: "Asia/Dhaka", title: "Product catch-up", spaceName: "Design collective", organizerName: "Atiq", attendeeCount: 5,
};

beforeEach(() => {
  feeds.upcoming.mockReturnValue({ data: { pages: [{ schedules: [] }] } });
  feeds.followUps.mockReturnValue({ data: undefined });
});

/** Ninety minutes before the schedule above, on the same day. */
const NOW = Date.parse(schedule.startsAt) - 90 * 60_000;

const liveThread = {
  id: "space-1", kind: "space", slug: "growth", code: null, title: "Growth team", lastActivityAt: null, latestMeeting: null,
  openMeeting: { meetingId: "m-live", code: "liv-ecod-eee", title: "Design crit", startedAt: new Date(NOW - 4 * 60_000).toISOString(), participantCount: 3 },
} as const;

describe("Today", () => {
  it("puts what is happening now first, with a way in", () => {
    const html = renderToStaticMarkup(<Today threads={[liveThread]} now={NOW} />);
    expect(html).toContain("Design crit");
    expect(html).toContain("Happening now");
    expect(html).toContain("3 in the room");
    expect(html).toContain("started 4 min ago");
    expect(html).toContain('href="/liv-ecod-eee"');
  });

  it("lists the rest of today at its time, skipping terminal schedules", () => {
    feeds.upcoming.mockReturnValue({ data: { pages: [{ schedules: [{ ...schedule, state: "canceled", title: "Canceled call" }, schedule] }] } });
    const html = renderToStaticMarkup(<Today threads={[]} now={NOW} />);
    expect(html).toContain("Product catch-up");
    expect(html).toContain("in 1 h 30 min");
    expect(html).toContain("5 invited");
    expect(html).toContain('href="/abc-defg-hij"');
    expect(html).not.toContain("Canceled call");
  });

  it("keeps late-start meetings reachable and labels their state", () => {
    feeds.upcoming.mockReturnValue({ data: { pages: [{ schedules: [] }, { schedules: [{ ...schedule, state: "late_start", title: null }] }] } });
    const html = renderToStaticMarkup(<Today threads={[]} now={NOW} />);
    expect(html).toContain("Not started yet");
    expect(html).toContain("Scheduled meeting");
    expect(html).toContain('href="/abc-defg-hij"');
  });

  it("says when the day is clear and offers scheduling", () => {
    const html = renderToStaticMarkup(<Today threads={[]} now={NOW} />);
    expect(html).toContain("Nothing else today");
    expect(html).toContain("Your calendar is clear.");
    expect(html).toContain("Schedule a meeting");
  });
});

describe("Still to do", () => {
  it("is not on Home until there is something still to do", () => {
    expect(renderToStaticMarkup(<StillToDo />)).toBe("");
    feeds.followUps.mockReturnValue({ data: { followUps: [] } });
    expect(renderToStaticMarkup(<StillToDo />)).toBe("");
  });

  it("says whose each one is and which meeting it came from", () => {
    feeds.followUps.mockReturnValue({
      data: {
        followUps: [
          { id: "f1", text: "Send the practice set", ownerName: "Atiq", done: false, meetingId: "m1", meetingTitle: "Fractions practice", meetingStartedAt: "2026-03-05T10:00:00.000Z" },
          { id: "f2", text: "Book the next session", ownerName: null, done: false, meetingId: "m2", meetingTitle: null, meetingStartedAt: "2026-03-04T10:00:00.000Z" },
        ],
      },
    });
    const html = renderToStaticMarkup(<StillToDo />);
    expect(html).toContain("Still to do");
    expect(html).toContain("2 open");
    expect(html).toContain("Send the practice set — Atiq · Fractions practice, ");
    expect(html).toContain("Book the next session — A call, ");
  });
});

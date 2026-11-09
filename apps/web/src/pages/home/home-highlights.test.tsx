import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JustEnded, Upcoming } from "./home-highlights";

const feeds = vi.hoisted(() => ({ upcoming: vi.fn(), meetings: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useSuspenseInfiniteQuery: feeds.upcoming,
  useInfiniteQuery: feeds.meetings,
}));
vi.mock("@/app/query-client/queries/meetings", () => ({
  homeRecentMeetingsQueryOptions: () => ({}),
  myUpcomingMeetingSchedulesQueryOptions: () => ({}),
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
});

/** Ninety minutes before the schedule above, on the same day. */
const NOW = Date.parse(schedule.startsAt) - 90 * 60_000;

const liveThread = {
  id: "space-1", kind: "space", slug: "growth", code: null, title: "Growth team", lastActivityAt: null, latestMeeting: null,
  openMeeting: { meetingId: "m-live", code: "liv-ecod-eee", title: "Design crit", startedAt: new Date(NOW - 4 * 60_000).toISOString(), participantCount: 3 },
} as const;

describe("Upcoming", () => {
  it("puts what is happening now first, with a way in", () => {
    const html = renderToStaticMarkup(<Upcoming threads={[liveThread]} now={NOW} />);
    expect(html).toContain("Design crit");
    expect(html).toContain("Happening now");
    expect(html).toContain("3 in the meeting");
    expect(html).toContain('href="/liv-ecod-eee"');
  });

  it("lists scheduled meetings with a way in, skipping terminal schedules", () => {
    feeds.upcoming.mockReturnValue({ data: { pages: [{ schedules: [{ ...schedule, state: "canceled", title: "Canceled call" }, schedule] }] } });
    const html = renderToStaticMarkup(<Upcoming threads={[]} now={NOW} />);
    expect(html).toContain("Product catch-up");
    expect(html).toContain("Today,");
    expect(html).toContain('href="/abc-defg-hij"');
    expect(html).not.toContain("Canceled call");
  });

  it("keeps late-start meetings reachable and labels their state", () => {
    feeds.upcoming.mockReturnValue({ data: { pages: [{ schedules: [] }, { schedules: [{ ...schedule, state: "late_start", title: null }] }] } });
    const html = renderToStaticMarkup(<Upcoming threads={[]} now={NOW} />);
    expect(html).toContain("Not started yet");
    expect(html).toContain("Scheduled meeting");
    expect(html).toContain('href="/abc-defg-hij"');
  });

  it("always offers scheduling, and says when nothing is planned", () => {
    const html = renderToStaticMarkup(<Upcoming threads={[]} now={NOW} />);
    expect(html).toContain("Nothing scheduled.");
    expect(html).toContain("Schedule a meeting");
  });
});

describe("Just ended", () => {
  const ended = { meetingId: "m1", title: "Design sync", participantNames: ["Maya", "Sam"], hasSummary: true };

  it("leads to the meeting you left, once it is over", () => {
    feeds.meetings.mockReturnValue({ data: { pages: [{ meetings: [ended] }] } });
    const html = renderToStaticMarkup(<JustEnded meetingId="m1" viewerName="Maya" onDismiss={() => {}} />);
    expect(html).toContain("Design sync just ended");
    expect(html).toContain("Open meeting");
  });

  it("shows nothing while the meeting is still going", () => {
    feeds.meetings.mockReturnValue({ data: { pages: [{ meetings: [{ ...ended, meetingId: "other" }] }] } });
    expect(renderToStaticMarkup(<JustEnded meetingId="m1" viewerName="Maya" onDismiss={() => {}} />)).toBe("");
  });
});

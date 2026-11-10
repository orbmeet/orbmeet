import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowRight, Presentation, Video } from "lucide-react";
import { homeRecentMeetingsQueryOptions } from "@/app/query-client/queries/meetings";
import { MeetingBoardPreview } from "@/modules/meetings/client/components/meeting-board-preview";
import { formatMeetingDate, formatMeetingLength, meetingDisplayTitle } from "@/modules/meetings/client/components/meeting-format";
import { isShortCall } from "@/modules/meetings/client/components/meeting-row";
import { focus, layout } from "@orbmeet/ui/styles/atoms";
import { accent, border, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { fonts, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { SampleRoom } from "./landing-tour";

const styles = stylex.create({
  card: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.subtle,
    borderRadius: 18,
    backgroundColor: surface.raised,
    boxShadow: { default: shadows.card, [env.hoverable]: { default: shadows.card, ":hover": shadows.cardHover } },
    transitionProperty: "box-shadow",
    transitionDuration: "160ms",
  },
  // The whole card is one link; the visible words are its label.
  cover: { position: "absolute", inset: 0, zIndex: 1, borderRadius: 18 },
  thumb: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    aspectRatio: "16 / 10",
    backgroundColor: surface.board,
    color: neutral.n400,
  },
  body: { display: "flex", flexDirection: "column", gap: space.s1, paddingBlock: space.s5, paddingInline: space.s6 },
  kicker: { margin: 0, fontSize: text.control, fontWeight: weight.medium, color: accent.a700 },
  title: { margin: 0, fontFamily: fonts.heading, fontSize: text.xl2, fontWeight: weight.semibold, letterSpacing: "-0.02em" },
  meta: { margin: 0, fontSize: text.sm, color: ink.muted },
  open: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    marginTop: space.s3,
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: accent.a700,
  },
});

/**
 * The most recent meeting worth going back to, with the board it left — the
 * same picture Home leads with. Someone with no meetings yet sees the sample
 * call instead, so the space shows what a call here looks like.
 */
export function LatestMeeting({ viewerName }: { viewerName: string }) {
  const query = useInfiniteQuery(homeRecentMeetingsQueryOptions());
  const latest = (query.data?.pages[0]?.meetings ?? []).find((meeting) => !isShortCall(meeting));

  if (query.isPending) return <div aria-hidden="true" {...stylex.props(styles.card, styles.thumb)} />;
  if (!latest) return <SampleRoom />;

  const title = meetingDisplayTitle(latest.title, latest.participantNames, viewerName);
  const others = latest.participantNames.filter((name) => name !== viewerName);
  const details = [
    formatMeetingDate(latest.startedAt),
    formatMeetingLength(latest.startedAt, latest.endedAt),
    others.length > 0 ? `with ${others.join(", ")}` : null,
  ].filter(Boolean);
  const hasBoard = latest.hasWhiteboardState || latest.hasWhiteboardPdf;

  return (
    <section aria-labelledby="landing-latest" {...stylex.props(styles.card)}>
      <Link
        to="/meetings/$meetingId"
        params={{ meetingId: latest.meetingId }}
        aria-label={`Open ${title}`}
        {...stylex.props(styles.cover, focus.ring)}
      />
      <span aria-hidden="true" {...stylex.props(styles.thumb)}>
        {hasBoard ? (
          <MeetingBoardPreview meetingId={latest.meetingId} fallback={<Presentation size={40} strokeWidth={1.4} />} />
        ) : (
          <Video size={40} strokeWidth={1.4} />
        )}
      </span>
      <div {...stylex.props(styles.body)}>
        <p {...stylex.props(styles.kicker)}>Latest meeting</p>
        <h2 id="landing-latest" {...stylex.props(styles.title, layout.truncate)}>{title}</h2>
        <p {...stylex.props(styles.meta)}>{details.join(" · ")}</p>
        <span aria-hidden="true" {...stylex.props(styles.open)}>
          Open the recap
          <ArrowRight size={15} strokeWidth={2} />
        </span>
      </div>
    </section>
  );
}

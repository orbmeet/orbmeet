import * as stylex from "@stylexjs/stylex";
import { useMemo, useState } from "react";
import { useIsMuted, useIsSpeaking, useParticipants, useSpeakingParticipants } from "@livekit/components-react";
import { Track, type Participant } from "livekit-client";
import { ChevronDown, ChevronUp, Hand, MicOff } from "lucide-react";
import { Avatar, Tooltip } from "@orbmeet/ui/react";
import { focus, layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, border, danger, ink, neutral, surface, warning } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import { scrim } from "@orbmeet/ui/tokens/wash.stylex";
import { videoTrack } from "@/modules/meetings/client/meeting-styles";
import { MeetingVideoTrack } from "../meeting-video-track";
import { PeopleFacepile } from "../people-facepile";
import { useHandRaised } from "./hand-badge";
import { useActiveVideoTracks, type VideoTrackRef } from "./tracks";
import { useRecentSpeakerOrder } from "./use-recent-speaker-order";

/**
 * How many faces each place has room for, yours among them; everyone else is
 * behind "+N".
 *
 * - `column`      over a panel beside the board: three across, two down.
 * - `columnRoomy` the column with no panel under it: two across, larger.
 * - `row`         under an upright phone's board: one row.
 * - `rowWide`     under an upright tablet's board, twice the phone's width.
 */
const MAX_FACES = { column: 6, columnRoomy: 6, row: 3, rowWide: 5 } as const;

const styles = stylex.create({
  column: {
    display: "flex",
    flexShrink: 0,
    flexDirection: "column",
    gap: space.s2_5,
    padding: space.s3,
    boxShadow: `inset 0 -1px 0 ${border.subtle}`,
  },
  /** Nothing under it: the faces take the column, and scroll if a short window asks. */
  columnRoomy: { flexGrow: 1, minHeight: 0, overflowY: "auto", boxShadow: "none" },
  head: { display: "flex", minHeight: 28, alignItems: "center", gap: space.s2 },
  title: { minWidth: 0, flexGrow: 1, fontSize: text.control, fontWeight: weight.semibold, color: ink.strong },
  count: { marginInlineStart: space.s1_5, fontWeight: weight.medium, color: neutral.n500, fontVariantNumeric: "tabular-nums" },
  headButton: {
    display: "inline-flex",
    height: 28,
    minWidth: 28,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: space.s1,
    borderWidth: 0,
    borderRadius: radii.field,
    paddingInline: space.s1_5,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: { default: neutral.n600, [env.hoverable]: { default: neutral.n600, ":hover": neutral.n900 } },
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
    cursor: "pointer",
  },
  grid: { display: "grid", gap: space.s2 },
  gridThree: { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" },
  gridTwo: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
  /** Under an upright board: the faces across, the full width. */
  row: {
    display: "grid",
    flexShrink: 0,
    gridAutoColumns: "minmax(0, 1fr)",
    gridAutoFlow: "column",
    gap: space.s2,
  },
  face: { display: "flex", minWidth: 0, flexDirection: "column", gap: space.s1 },
  frame: {
    position: "relative",
    overflow: "hidden",
    // Over a moving picture the corners must stay clipped in WebKit, which
    // composites a <video> on its own layer and can paint past `overflow`.
    isolation: "isolate",
    borderRadius: radii.control,
    backgroundColor: neutral.n100,
  },
  /**
   * Square beside the board, three across: a face is taller than it is wide,
   * and a 16:10 frame in a 300px column cut heads off at the brow.
   */
  frameColumn: { aspectRatio: "1 / 1" },
  frameColumnRoomy: { aspectRatio: "4 / 3" },
  /**
   * 4:3 under an upright board, a camera's own shape, held to a height the
   * board can spare. A fixed 84px under the whole width turned each picture
   * into a letterbox, so a phone's faces showed foreheads and ceiling fans.
   */
  frameRow: { aspectRatio: "4 / 3", maxHeight: 104 },
  /** The ring over the picture, not under it: an inset shadow is painted beneath a child <video>. */
  ring: {
    position: "absolute",
    inset: 0,
    zIndex: 1,
    borderRadius: "inherit",
    boxShadow: `inset 0 0 0 1px ${scrim.edge}`,
    pointerEvents: "none",
  },
  /** Whoever is talking: the room's one blue ring. */
  ringSpeaking: { boxShadow: `inset 0 0 0 2px ${accent.a500}` },
  /** A hand up: amber, the room's colour for waiting to speak. */
  ringWaiting: { boxShadow: `inset 0 0 0 2px ${warning.w400}` },
  avatarBed: { display: "grid", width: "100%", height: "100%", placeItems: "center" },
  hand: {
    position: "absolute",
    top: space.s1_5,
    left: space.s1_5,
    zIndex: 2,
    display: "grid",
    width: 22,
    height: 22,
    placeItems: "center",
    borderRadius: radii.pill,
    backgroundColor: warning.w100,
    color: warning.w800,
  },
  /** On the picture, where a line under it would cost the board its height. */
  chip: {
    position: "absolute",
    left: space.s1,
    bottom: space.s1,
    zIndex: 2,
    display: "flex",
    maxWidth: `calc(100% - ${space.s2})`,
    alignItems: "center",
    gap: 3,
    borderRadius: radii.field,
    backgroundColor: `color-mix(in oklab, ${surface.raised} 90%, transparent)`,
    paddingInline: space.s1_5,
    fontSize: text.xs2,
    lineHeight: "18px",
    fontWeight: weight.semibold,
    color: ink.strong,
  },
  muted: { flexShrink: 0, color: danger.d500 },
  more: {
    display: "grid",
    aspectRatio: "4 / 3",
    maxHeight: 104,
    placeItems: "center",
    borderWidth: 0,
    borderRadius: radii.control,
    backgroundColor: { default: neutral.n100, [env.hoverable]: { default: neutral.n100, ":hover": neutral.n150 } },
    fontFamily: "inherit",
    fontSize: text.sm,
    fontWeight: weight.semibold,
    fontVariantNumeric: "tabular-nums",
    color: neutral.n700,
    cursor: "pointer",
  },
  /** Raised hands, in turn: who is next, and the way to give them the floor. */
  hands: {
    display: "flex",
    minHeight: 32,
    alignItems: "center",
    gap: space.s2,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: warning.w200,
    backgroundColor: warning.w50,
    paddingInlineStart: space.s2_5,
    paddingInlineEnd: space.s1_5,
    fontSize: text.xs,
    color: warning.w800,
  },
  handsText: { minWidth: 0, flexGrow: 1 },
  handsFirst: { fontWeight: weight.semibold },
  callOn: {
    flexShrink: 0,
    height: 22,
    borderWidth: 0,
    borderRadius: radii.field,
    backgroundColor: { default: warning.w500, [env.hoverable]: { default: warning.w500, ":hover": warning.w400 } },
    paddingInline: space.s2,
    fontFamily: "inherit",
    fontSize: text.xs2,
    fontWeight: weight.bold,
    color: warning.w950,
    cursor: "pointer",
  },
});

interface RoomFacesProps {
  /**
   * `column`: the top of the column beside a wide board. `row`: across the
   * foot of an upright one.
   */
  variant: "column" | "row";
  /** The column with no panel under it, or a tablet's row: room for more, or larger, faces. */
  roomy?: boolean;
  /** A recording: the faces, and none of the controls. */
  readOnly?: boolean;
  /** Hands up, longest-waiting first, as far as this viewer knows them. */
  raisedHands: readonly { userId: string; userName: string }[];
  onShowEveryone: () => void;
  /** Gives the first hand the floor; only for someone who may, and only in the column. */
  onCallOn?: (userId: string) => void;
}

/**
 * The room beside content: the people worth seeing now — anyone with a hand
 * up, then whoever is talking or talked last, then cameras before avatars —
 * then you, and "+N" for everyone else, which opens People.
 *
 * You are in it, last. You were left out as the face you need least, but the
 * header still counted you ("In the room 3" over two faces), and on a phone
 * the board was the only place to look while your camera showed the ceiling.
 * A recording has no "you": its own participant is the recorder.
 */
export function RoomFaces({
  variant,
  roomy = false,
  readOnly = false,
  raisedHands,
  onShowEveryone,
  onCallOn,
}: RoomFacesProps) {
  const [folded, setFolded] = useState(false);
  const participants = useParticipants();
  const max =
    variant === "row"
      ? roomy ? MAX_FACES.rowWide : MAX_FACES.row
      : roomy ? MAX_FACES.columnRoomy : MAX_FACES.column;
  const { shown, cameraByIdentity, hidden } = useFacesInView(participants, raisedHands, max, !readOnly);
  // Alone, there is nobody to show: your own face by itself is not a room.
  if (!shown.some((participant) => !participant.isLocal)) return null;

  const everyone = `${participants.length} in the meeting`;
  const queued = new Set(raisedHands.map((hand) => hand.userId));
  const faces = shown.map((participant) => (
    <Face
      key={participant.identity}
      participant={participant}
      track={cameraByIdentity.get(participant.identity)}
      queued={queued.has(participant.identity)}
      variant={variant}
      roomy={roomy}
    />
  ));

  if (variant === "row") {
    return (
      <section aria-label="People in the meeting" {...stylex.props(styles.row)}>
        {faces}
        {hidden > 0 && !readOnly && (
          <button
            type="button"
            onClick={onShowEveryone}
            aria-label={`Show everyone, ${everyone}`}
            {...stylex.props(pressable.base, motion.tint, focus.ring, styles.more)}
          >
            {`+${hidden}`}
          </button>
        )}
      </section>
    );
  }

  const [first, second] = raisedHands;
  return (
    <section aria-label="People in the meeting" {...stylex.props(styles.column, roomy && !folded && styles.columnRoomy)}>
      <div {...stylex.props(styles.head)}>
        {folded && <PeopleFacepile />}
        <span {...stylex.props(styles.title, layout.truncate)}>
          In the room<span {...stylex.props(styles.count)}>{participants.length}</span>
        </span>
        {hidden > 0 && !folded && !readOnly && (
          <Tooltip content={`Everyone · ${everyone}`} side="bottom">
            <button
              type="button"
              onClick={onShowEveryone}
              aria-label={`Show everyone, ${everyone}`}
              {...stylex.props(pressable.base, motion.tint, focus.ring, styles.headButton)}
            >
              {`+${hidden}`}
            </button>
          </Tooltip>
        )}
        {!readOnly && (
          <Tooltip content={folded ? "Show faces" : "Fold faces away"} side="bottom">
            <button
              type="button"
              onClick={() => setFolded(!folded)}
              aria-expanded={!folded}
              aria-label={folded ? "Show faces" : "Fold faces away"}
              {...stylex.props(pressable.base, motion.tint, focus.ring, styles.headButton)}
            >
              {folded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
            </button>
          </Tooltip>
        )}
      </div>
      {!folded && (
        // Two faces, two across, rather than three columns with one left empty.
        <div {...stylex.props(styles.grid, roomy || shown.length <= 2 ? styles.gridTwo : styles.gridThree)}>{faces}</div>
      )}
      {first && onCallOn && !readOnly && (
        <div role="status" aria-label="Raised hands" {...stylex.props(styles.hands)}>
          <Hand size={13} strokeWidth={2.2} aria-hidden="true" />
          <span {...stylex.props(styles.handsText, layout.truncate)}>
            <span {...stylex.props(styles.handsFirst)}>{firstWord(first.userName)}</span>
            {second && `, then ${firstWord(second.userName)}`}
            {raisedHands.length > 2 && ` +${raisedHands.length - 2}`}
          </span>
          <button
            type="button"
            onClick={() => onCallOn(first.userId)}
            aria-label={`Let ${first.userName} speak`}
            {...stylex.props(pressable.base, motion.tint, focus.ring, styles.callOn)}
          >
            Call on {firstWord(first.userName)}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Who to show, in order, and how many are left over. Who talked recently
 * stays in view without a shuffle on every sentence. You, when you are shown,
 * take the last place, so the others fill the ones before it.
 */
function useFacesInView(
  participants: Participant[],
  raisedHands: RoomFacesProps["raisedHands"],
  max: number,
  includeSelf: boolean,
) {
  const others = useMemo(() => participants.filter((participant) => !participant.isLocal), [participants]);
  const self = includeSelf ? participants.find((participant) => participant.isLocal) : undefined;
  const othersInView = self ? max - 1 : max;
  const tracks = useActiveVideoTracks({ includeScreenShare: false });
  const cameraByIdentity = useMemo(
    () => new Map(tracks.map((track) => [track.participant.identity, track])),
    [tracks],
  );
  const speakers = useSpeakingParticipants();
  const { order } = useRecentSpeakerOrder({
    present: others.map((participant) => participant.identity),
    speaking: speakers.map((speaker) => speaker.identity),
    inView: othersInView,
    fixed: [],
  });
  const handIds = useMemo(() => raisedHands.map((hand) => hand.userId), [raisedHands]);
  const speakingIds = useMemo(() => new Set(speakers.map((speaker) => speaker.identity)), [speakers]);
  const shown = useMemo(() => {
    const hands = new Set(handIds);
    const byIdentity = new Map(others.map((participant) => [participant.identity, participant]));
    // After the hands: whoever is talking now, then whoever has a camera on,
    // then everyone else — each group in the speaker order. The order alone
    // starts from who joined first, so a late arrival with their camera on
    // would sit behind "+N" until they spoke while silent avatars held the
    // place. A face is worth more here than a name.
    const rank = (id: string) => (speakingIds.has(id) ? 0 : cameraByIdentity.has(id) ? 1 : 2);
    const rest = order
      .filter((id) => !hands.has(id))
      .map((id, index) => ({ id, index, rank: rank(id) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.id);
    const ids = [...handIds.filter((id) => byIdentity.has(id)), ...rest];
    return ids.slice(0, othersInView).flatMap((id) => byIdentity.get(id) ?? []);
  }, [cameraByIdentity, handIds, othersInView, order, others, speakingIds]);
  return {
    shown: self ? [...shown, self] : shown,
    cameraByIdentity,
    hidden: others.length - shown.length,
  };
}

function Face({
  participant,
  track,
  queued,
  variant,
  roomy,
}: {
  participant: Participant;
  track: VideoTrackRef | undefined;
  /** In the queue a moderator sees, which can land before the attribute does. */
  queued: boolean;
  variant: RoomFacesProps["variant"];
  roomy: boolean;
}) {
  const speaking = useIsSpeaking(participant);
  const muted = useIsMuted({ participant, source: Track.Source.Microphone });
  const handUp = useHandRaised(participant) || queued;
  const self = participant.isLocal;
  const name = participant.name || "Participant";
  // Three across leaves room for a first name; the roomy column, a full one.
  const shownName = self ? "You" : variant === "column" && roomy ? name : firstWord(name);
  const frame = variant === "row" ? styles.frameRow : roomy ? styles.frameColumnRoomy : styles.frameColumn;
  return (
    <div
      role="img"
      aria-label={`${self ? "You" : name}${speaking ? ", talking" : ""}${handUp ? ", hand raised" : ""}${muted ? ", muted" : ""}`}
      {...stylex.props(styles.face)}
    >
      <div {...stylex.props(styles.frame, frame)}>
        {track ? (
          // Yours mirrored, as in the gallery: a camera that moves the other
          // way from your hand reads as someone else's.
          <MeetingVideoTrack trackRef={track} {...stylex.props(videoTrack.fill, self && videoTrack.mirrored)} />
        ) : (
          <div {...stylex.props(styles.avatarBed)}>
            <Avatar name={name} sizePx={variant === "row" ? 32 : 40} />
          </div>
        )}
        <span aria-hidden="true" {...stylex.props(styles.ring, handUp && styles.ringWaiting, speaking && styles.ringSpeaking)} />
        {handUp && (
          <span aria-hidden="true" {...stylex.props(styles.hand)}>
            <Hand size={12} strokeWidth={2.4} />
          </span>
        )}
        <span aria-hidden="true" {...stylex.props(styles.chip)}>
          {muted && <MicOff size={12} strokeWidth={2.2} aria-hidden="true" {...stylex.props(styles.muted)} />}
          <span {...stylex.props(layout.truncate)}>{shownName}</span>
        </span>
      </div>
    </div>
  );
}

function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

import * as React from "react";
import { Check } from "lucide-react";
import { RoomEvent, Track, TrackEvent, type LocalTrack } from "livekit-client";
import { useMaybeRoomContext } from "@livekit/components-react";
import { layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, ink, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

import { MicrophoneLevelMeter } from "@/modules/meetings/client/components/microphone-level-meter";
import { env } from "@orbmeet/ui/tokens/media.stylex";

const styles = stylex.create({
  root: { width: "100%" },
  /** Sections are separated by a rule, not a gap: this panel is a list. */
  section: {
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: neutral.n100,
  },
  meter: { paddingInline: space.s2_5, paddingBottom: space.s2, paddingTop: space.s1 },
  group: { paddingBottom: space.s1 },
  label: {
    margin: 0,
    paddingInline: space.s2_5,
    paddingTop: space.s2,
    paddingBottom: space.s1,
    fontSize: text.xs2,
    fontWeight: weight.semibold,
    textTransform: "uppercase",
    letterSpacing: tracking.wider,
    color: ink.muted,
  },
  row: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s2,
    borderRadius: radii.control,
    borderWidth: 0,
    backgroundColor: "transparent",
    paddingInline: space.s2_5,
    paddingBlock: space.s2,
    textAlign: "start",
    fontFamily: "inherit",
    fontSize: text.xs,
  },
  rowIdle: {
    color: neutral.n700,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n100 } },
  },
  rowSelected: { backgroundColor: accent.a50, fontWeight: weight.medium, color: accent.a800 },
  /**
   * The check keeps its space when it is not shown, so selecting a different
   * device does not shift every label in the list sideways.
   */
  check: { flexShrink: 0, visibility: "hidden" },
  checkOn: { visibility: "visible", color: accent.a600 },
});

export interface MeetingAudioDevicePanelProps {
  isMicOn: boolean;
  audioDevices: MediaDeviceInfo[];
  currentAudioDeviceId?: string;
  onSelectAudioDevice: (deviceId: string | undefined) => Promise<void>;
  audioOutputDevices?: MediaDeviceInfo[];
  currentAudioOutputDeviceId?: string;
  onSelectAudioOutputDevice?: (deviceId: string | undefined) => Promise<void>;
  /** Avoid room subscriptions while the containing popover or sheet is closed. */
  active?: boolean;
  sx?: StyleXStyles;
}

/**
 * The common audio-device surface used by both desktop and phone controls.
 * Keeping device switching in one component prevents the two meeting layouts
 * from drifting in capability checks, selected-state handling, and labelling.
 */
export function MeetingAudioDevicePanel({
  isMicOn,
  audioDevices,
  currentAudioDeviceId,
  onSelectAudioDevice,
  audioOutputDevices = [],
  currentAudioOutputDeviceId,
  onSelectAudioOutputDevice,
  active = true,
  sx,
}: MeetingAudioDevicePanelProps) {
  const micTrack = useLocalMicrophoneTrack(active);

  return (
    <div {...stylex.props(styles.root, sx)}>
      <DeviceSection
        label="Microphone"
        devices={audioDevices}
        currentDeviceId={currentAudioDeviceId}
        fallbackLabel="Microphone"
        onSelect={onSelectAudioDevice}
      />
      {onSelectAudioOutputDevice && audioOutputDevices.length > 0 && (
        <div {...stylex.props(styles.section)}>
          <DeviceSection
            label="Speaker"
            devices={audioOutputDevices}
            currentDeviceId={currentAudioOutputDeviceId}
            fallbackLabel="Speaker"
            onSelect={onSelectAudioOutputDevice}
          />
        </div>
      )}
      <div {...stylex.props(styles.section, styles.meter)}>
        <SectionLabel>Input level</SectionLabel>
        <MicrophoneLevelMeter track={micTrack} enabled={isMicOn} />
      </div>
    </div>
  );
}

/**
 * Follow the local microphone across publish, mute, and device replacement so
 * the level meter never holds a stopped MediaStreamTrack after a hot-plug.
 */
function useLocalMicrophoneTrack(active: boolean): MediaStreamTrack | null {
  const room = useMaybeRoomContext();
  const [track, setTrack] = React.useState<MediaStreamTrack | null>(null);

  React.useEffect(() => {
    if (!active || !room) {
      setTrack(null);
      return;
    }

    let boundTrack: LocalTrack | null = null;
    const update = () => {
      const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      const localTrack = publication?.track ?? null;
      if (localTrack !== boundTrack) {
        boundTrack?.off(TrackEvent.Restarted, update);
        boundTrack = localTrack;
        boundTrack?.on(TrackEvent.Restarted, update);
      }
      setTrack(publication?.track?.mediaStreamTrack ?? null);
    };

    update();
    room.on(RoomEvent.LocalTrackPublished, update);
    room.on(RoomEvent.LocalTrackUnpublished, update);
    room.on(RoomEvent.TrackMuted, update);
    room.on(RoomEvent.TrackUnmuted, update);
    room.on(RoomEvent.ActiveDeviceChanged, update);
    return () => {
      room.off(RoomEvent.LocalTrackPublished, update);
      room.off(RoomEvent.LocalTrackUnpublished, update);
      room.off(RoomEvent.TrackMuted, update);
      room.off(RoomEvent.TrackUnmuted, update);
      room.off(RoomEvent.ActiveDeviceChanged, update);
      boundTrack?.off(TrackEvent.Restarted, update);
    };
  }, [active, room]);

  return track;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p {...stylex.props(styles.label)}>
      {children}
    </p>
  );
}

function DeviceSection({
  label,
  devices,
  currentDeviceId,
  fallbackLabel,
  onSelect,
}: {
  label: string;
  devices: MediaDeviceInfo[];
  currentDeviceId?: string;
  fallbackLabel: string;
  onSelect: (deviceId: string | undefined) => Promise<void>;
}) {
  return (
    <div {...stylex.props(styles.group)}>
      <SectionLabel>{label}</SectionLabel>
      <DeviceRow
        selected={!currentDeviceId}
        label="System default"
        onClick={() => void onSelect(undefined)}
      />
      {devices.map((device) => (
        <DeviceRow
          key={device.deviceId}
          selected={currentDeviceId === device.deviceId}
          label={device.label || `${fallbackLabel} ${device.deviceId.slice(0, 8)}`}
          onClick={() => void onSelect(device.deviceId)}
        />
      ))}
    </div>
  );
}

function DeviceRow({
  selected,
  label,
  onClick,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      {...stylex.props(
        pressable.base,
        motion.tint,
        styles.row,
        selected ? styles.rowSelected : styles.rowIdle,
      )}
    >
      <Check size={14} {...stylex.props(styles.check, selected && styles.checkOn)} />
      <span {...stylex.props(layout.truncate)}>{label}</span>
    </button>
  );
}

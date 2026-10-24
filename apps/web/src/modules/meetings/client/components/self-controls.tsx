import * as React from "react";
import { Camera, Check, ChevronLeft, Hand, Languages, Mic, MicOff, RefreshCw, Video, VideoOff } from "lucide-react";
import { Toolbar } from "@base-ui/react/toolbar";
import { focus, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { BackgroundEffectPicker } from "./background-effect-picker";
import { CaptionLanguagePicker } from "./caption-language-picker";
import type {
  DockAudioDeviceControls,
  DockBackgroundControls,
} from "./dock-controls";
import { DockButton, DockMenuRow, DockSplitMenu, dockStyles } from "./dock-primitives";
import { MeetingAudioDevicePanel } from "./meeting-audio-device-panel";

const styles = stylex.create({
  menuWide: { width: 320 },
  effects: { paddingTop: space.s1 },
  /**
   * The language you speak, under the microphone it describes. It is what
   * captions and the transcript listen for, so it is a property of your mic,
   * not of the captions you happen to be reading.
   */
  language: {
    marginTop: space.s1,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: neutral.n100,
    paddingTop: space.s1,
  },
  languageRow: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s2_5,
    borderWidth: 0,
    borderRadius: radii.control,
    paddingInline: space.s2_5,
    paddingBlock: space.s2,
    textAlign: "start",
    fontFamily: "inherit",
    fontSize: text.xs,
    color: neutral.n800,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n50 } },
    cursor: "pointer",
  },
  languageText: { display: "flex", minWidth: 0, flexGrow: 1, flexDirection: "column", gap: 1 },
  languageName: { fontWeight: weight.medium },
  languageHint: { fontSize: text.xs2, lineHeight: leading.xs, color: neutral.n500 },
  languageChange: { flexShrink: 0, fontSize: text.xs2, fontWeight: weight.semibold, color: accent.a700 },
  languageIcon: { flexShrink: 0, color: neutral.n400 },
  pickerBack: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    marginBottom: space.s2,
    borderWidth: 0,
    borderRadius: radii.control,
    paddingInline: space.s1_5,
    paddingBlock: space.s1,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: neutral.n600,
    backgroundColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n50 } },
    cursor: "pointer",
  },
  picker: { height: 320 },
});

export interface SelfControlsProps {
  isMicOn: boolean;
  micPending?: boolean;
  onToggleMic: () => void;
  audio?: DockAudioDeviceControls;
  isCameraOn: boolean;
  onToggleCamera: () => void;
  camera?: {
    videoDevices: MediaDeviceInfo[];
    currentVideoDeviceId: string | undefined;
    onSelectVideoDevice: (deviceId: string | undefined) => void;
    onRefreshVideoDevices?: () => void;
  };
  background?: DockBackgroundControls;
  /** Raising your own hand. Omitted for moderators, whose hand button would only open the queue. */
  hand?: { isHandRaised: boolean; onToggle: () => void };
  /** The language you speak, which captions and the transcript listen for. */
  spokenLanguage?: SpokenLanguageControls;
}

interface SpokenLanguageControls {
  language: string;
  /** The language's name, as people say it ("English (United States)"). */
  label: string;
  /** Where the room thinks you are, to put nearby languages first. */
  country?: string | null;
  onSelect: (language: string) => void;
}

/**
 * The microphone menu's last section: the language you speak, and a picker in
 * place of the menu when you change it.
 */
function SpokenLanguage({
  spokenLanguage,
  picking,
  onPick,
  onDone,
}: {
  spokenLanguage: SpokenLanguageControls;
  picking: boolean;
  onPick: () => void;
  onDone: () => void;
}) {
  if (picking) {
    return (
      <div>
        <button type="button" onClick={onDone} {...stylex.props(pressable.base, motion.tint, focus.ring, styles.pickerBack)}>
          <ChevronLeft size={14} />
          My spoken language
        </button>
        <CaptionLanguagePicker
          variant="light"
          country={spokenLanguage.country ?? null}
          selectedLanguage={spokenLanguage.language}
          onSelectLanguage={(language) => {
            spokenLanguage.onSelect(language);
            onDone();
          }}
          sx={styles.picker}
          autoFocusSearch
        />
      </div>
    );
  }
  return (
    <div {...stylex.props(styles.language)}>
      <button type="button" onClick={onPick} {...stylex.props(pressable.base, motion.tint, focus.ring, styles.languageRow)}>
        <Languages size={16} strokeWidth={1.75} {...stylex.props(styles.languageIcon)} />
        <span {...stylex.props(styles.languageText)}>
          <span {...stylex.props(styles.languageName)}>I speak {spokenLanguage.label}</span>
          <span {...stylex.props(styles.languageHint)}>Used for captions and the transcript</span>
        </span>
        <span {...stylex.props(styles.languageChange)}>Change</span>
      </button>
    </div>
  );
}

function CameraMenu({
  camera,
  background,
  close,
}: {
  camera?: SelfControlsProps["camera"];
  background?: DockBackgroundControls;
  close: () => void;
}) {
  const devices = (camera?.videoDevices ?? []).filter((device) => device.deviceId !== "default");
  const effects =
    background?.isSupported === true ? background : undefined;
  return (
    <>
      {camera && (
        <>
          <p {...stylex.props(dockStyles.menuHeading)}>Camera</p>
          <DockMenuRow
            icon={camera.currentVideoDeviceId === undefined ? Check : Camera}
            label="System default"
            onClick={() => {
              camera.onSelectVideoDevice(undefined);
              close();
            }}
          />
          {devices.map((device) => (
            <DockMenuRow
              key={device.deviceId}
              icon={camera.currentVideoDeviceId === device.deviceId ? Check : Camera}
              label={device.label || `Camera ${device.deviceId.slice(0, 8)}`}
              onClick={() => {
                camera.onSelectVideoDevice(device.deviceId);
                close();
              }}
            />
          ))}
          {camera.onRefreshVideoDevices && (
            <DockMenuRow
              icon={RefreshCw}
              label="Look for cameras again"
              onClick={camera.onRefreshVideoDevices}
            />
          )}
        </>
      )}
      {effects && (
        <>
          {camera && <div aria-hidden="true" {...stylex.props(dockStyles.menuRule)} />}
          <p {...stylex.props(dockStyles.menuHeading)}>Background</p>
          <div {...stylex.props(styles.effects)}>
            <BackgroundEffectPicker
              variant="light"
              mode={effects.mode}
              imagePath={effects.imagePath}
              isProcessing={effects.isProcessing}
              onSelectNone={() => {
                effects.clearEffect();
                close();
              }}
              onSelectBlur={() => {
                effects.setBlur();
                close();
              }}
              onSelectImage={(path) => {
                effects.setImage(path);
                close();
              }}
            />
          </div>
        </>
      )}
    </>
  );
}

/**
 * Your controls, at the head of the room's top strip.
 *
 * Mic and camera used to be two anonymous glyphs among fourteen. Here they
 * are one object, each with its device settings in a split chevron; the
 * background effect lives with the camera it changes, and your spoken
 * language with the microphone it describes.
 */
export function SelfControls({
  isMicOn,
  micPending = false,
  onToggleMic,
  audio,
  isCameraOn,
  onToggleCamera,
  camera,
  background,
  hand,
  spokenLanguage,
}: SelfControlsProps) {
  const hasCameraMenu = Boolean(camera) || background?.isSupported === true;
  const [pickingLanguage, setPickingLanguage] = React.useState(false);
  return (
    // Your controls, as one object: microphone and camera, each with its
    // settings. Your face is not here — it is on the stage with everyone
    // else's, or beside the board with theirs — so the pill is controls only.
    <Toolbar.Group aria-label="You" {...stylex.props(dockStyles.cluster)}>
      <div {...stylex.props(dockStyles.split)}>
        <DockButton
          icon={isMicOn ? Mic : MicOff}
          label={isMicOn ? "Mute" : "Unmute"}
          // Muted, it says so in words from a tablet up: a red crossed-out mic
          // alone read as a status rather than as the button that ends it.
          // On, it is labelled wherever the bar has room.
          showLabel={isMicOn ? "wide" : true}
          tooltip={micPending ? "Microphone is updating" : isMicOn ? "Mute your microphone" : "Unmute your microphone"}
          off={!isMicOn}
          sx={audio ? dockStyles.splitStart : undefined}
          onClick={onToggleMic}
        />
        {audio && (
          <DockSplitMenu
            label="Audio settings"
            off={!isMicOn}
            panelSx={spokenLanguage ? styles.menuWide : undefined}
            onOpenChange={(open) => {
              if (!open) setPickingLanguage(false);
            }}
          >
            {({ open }) => (
              <>
                {!pickingLanguage && (
                  <MeetingAudioDevicePanel
                    isMicOn={isMicOn}
                    audioDevices={audio.audioDevices}
                    currentAudioDeviceId={audio.currentAudioDeviceId}
                    onSelectAudioDevice={audio.handleSelectAudioDevice}
                    audioOutputDevices={audio.audioOutputDevices}
                    currentAudioOutputDeviceId={audio.currentAudioOutputDeviceId}
                    onSelectAudioOutputDevice={audio.handleSelectAudioOutputDevice}
                    active={open}
                  />
                )}
                {spokenLanguage && (
                  <SpokenLanguage
                    spokenLanguage={spokenLanguage}
                    picking={pickingLanguage}
                    onPick={() => setPickingLanguage(true)}
                    onDone={() => setPickingLanguage(false)}
                  />
                )}
              </>
            )}
          </DockSplitMenu>
        )}
      </div>

      <div {...stylex.props(dockStyles.split)}>
        <DockButton
          icon={isCameraOn ? Video : VideoOff}
          label={isCameraOn ? "Stop video" : "Start video"}
          showLabel="wide"
          tooltip={isCameraOn ? "Turn your camera off" : "Turn your camera on"}
          off={!isCameraOn}
          sx={hasCameraMenu ? dockStyles.splitStart : undefined}
          onClick={onToggleCamera}
        />
        {hasCameraMenu && (
          <DockSplitMenu label="Camera settings" off={!isCameraOn} panelSx={styles.menuWide}>
            {({ close }) => <CameraMenu camera={camera} background={background} close={close} />}
          </DockSplitMenu>
        )}
      </div>

      {hand && (
        <DockButton
          icon={Hand}
          label={hand.isHandRaised ? "Lower hand" : "Raise hand"}
          showLabel="wide"
          active={hand.isHandRaised}
          onClick={hand.onToggle}
        />
      )}
    </Toolbar.Group>
  );
}

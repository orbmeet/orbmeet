import * as React from "react";
import { RotateCcw, Volume2 } from "lucide-react";
import { focus, motion, pressable, stack } from "@orbmeet/ui/styles/atoms";
import {
  danger,
  neutral,
  surface,
  warning,
} from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { Select } from "@orbmeet/ui/react";
import { MicrophoneLevelMeter } from "@/modules/meetings/client/components/microphone-level-meter";
import { PreJoinCaptionRow } from "@/modules/meetings/client/components/pre-join-caption-row";
import type { usePreJoinDevices } from "@/modules/meetings/client/use-pre-join-devices";
import {
  canSelectAudioOutput,
  playSpeakerTestTone,
} from "@/modules/meetings/client/speaker-test";
import { getDevicePickerPlaceholder } from "@/modules/meetings/client/pre-join-device-status";

const SYSTEM_DEFAULT_AUDIO_DEVICE = "__orbmeet_system_default_audio__";
const SYSTEM_DEFAULT_AUDIO_OUTPUT = "__orbmeet_system_default_audio_output__";
const SYSTEM_DEFAULT_VIDEO_DEVICE = "__orbmeet_system_default_video__";

const styles = stylex.create({
  /**
   * A field caption: small caps, quiet, above the control it names.
   *
   * Rendered as a `<span>`, not a `<label>`. Base UI's Select is named through
   * `aria-labelledby` pointing at this element, so a `<label>` here labelled
   * nothing — Chrome reported "No label associated with a form field" for each
   * of the three, and the orphans also stopped the browser autofilling the
   * hidden inputs the Select keeps for form submission.
   */
  fieldLabel: {
    display: "block",
    marginBottom: space.s1_5,
    fontSize: text.xs,
    fontWeight: weight.medium,
    letterSpacing: tracking.wide,
    textTransform: "uppercase",
    color: neutral.n500,
  },

  /**
   * Devices failed to enumerate. Amber, not red: a meeting can proceed without
   * pickers, so it is a warning with a way out, not a dead end.
   */
  deviceError: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: warning.w200,
    backgroundColor: warning.w50,
    paddingInline: space.s3,
    paddingBlock: space.s2_5,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: warning.w800,
  },
  deviceErrorText: { fontWeight: weight.medium },
  /** Capture works; only the picker is degraded. Quieter than the warning. */
  deviceNote: {
    borderRadius: radii.control,
    backgroundColor: neutral.n50,
    paddingInline: space.s3,
    paddingBlock: space.s2,
    fontSize: text.xs,
    lineHeight: leading.sm,
    color: neutral.n600,
  },
  retry: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.control,
    backgroundColor: surface.raised,
    paddingInline: space.s3,
    paddingBlock: space.s1_5,
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: warning.w800,
    boxShadow: shadows.hairline,
  },

  speakerRow: { display: "flex", alignItems: "center", gap: space.s2 },
  /** The select (or its fallback) takes the row; the test button keeps its size. */
  speakerSelect: { flexGrow: 1, minWidth: 0 },
  /** The static read-only field shown where the browser cannot switch output. */
  speakerFallback: {
    display: "flex",
    height: 44,
    alignItems: "center",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: neutral.n50,
    paddingInline: space.s3,
    fontSize: text.sm,
    color: neutral.n600,
  },
  speakerTest: {
    display: "flex",
    height: 44,
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1_5,
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: neutral.n200,
    backgroundColor: { default: surface.raised, ":active": neutral.n100 },
    paddingInline: space.s3,
    fontSize: text.sm,
    fontWeight: weight.medium,
    color: neutral.n700,
    // `wait`: the tone is already playing; the control is busy, not broken.
    cursor: { default: "pointer", ":disabled": "wait" },
    opacity: { default: 1, ":disabled": 0.6 },
  },
  speakerTestError: { marginTop: space.s1_5, marginBottom: 0, fontSize: text.xs, color: danger.d600 },
});

interface PreJoinDeviceFormProps {
  devices: ReturnType<typeof usePreJoinDevices>;
  captionLanguage: string;
  onCaptionLanguageChange: (language: string) => void;
  /**
   * Namespaces the label ids. The form is mounted twice — inline beside the
   * preview on desktop, inside the settings sheet on phones — and duplicate
   * ids would silently break the `aria-labelledby` on the second copy.
   */
  idPrefix: string;
  sx?: StyleXStyles;
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span id={id} {...stylex.props(styles.fieldLabel)}>
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * What is wrong with the devices, when something is — a blocked permission, a
 * missing microphone — and the way to try again.
 *
 * Its own component because it must never be folded away with the pickers:
 * the doorway shows it under the devices summary while the pickers are closed.
 */
export function PreJoinDeviceNotice({ devices }: { devices: PreJoinDeviceFormProps["devices"] }) {
  // `role="status"` with `aria-live="polite"`: the probe resolves after first
  // paint and can change again on retry, so a screen reader that has already
  // moved past this point must still be told the microphone is blocked.
  return (
    <div role="status" aria-live="polite" {...stylex.props(stack.x2)}>
      {devices.deviceNotice && (
        <div {...stylex.props(styles.deviceError)}>
          <span {...stylex.props(styles.deviceErrorText)}>
            {devices.deviceNotice.message}
            {devices.deviceNotice.consequence ? ` ${devices.deviceNotice.consequence}` : null}
          </span>
          {devices.deviceNotice.retryable && (
            <button
              type="button"
              onClick={devices.retryDevices}
              {...stylex.props(pressable.base, motion.tint, focus.ring, styles.retry)}
            >
              <RotateCcw size={14} />
              Retry
            </button>
          )}
        </div>
      )}
      {!devices.deviceNotice && devices.deviceNote && (
        <div {...stylex.props(styles.deviceNote)}>{devices.deviceNote}</div>
      )}
    </div>
  );
}

/**
 * Camera / microphone / speaker / caption-language pickers.
 *
 * Deliberately separate from the pre-join screen itself: on a phone these are
 * secondary to the three things you actually decide before joining (your name,
 * whether your camera is on, whether your mic is on), so they move behind a
 * "Settings" sheet rather than pushing the join button below the fold.
 */
export function PreJoinDeviceForm({
  devices,
  captionLanguage,
  onCaptionLanguageChange,
  idPrefix,
  sx,
}: PreJoinDeviceFormProps) {
  const [speakerTestPending, setSpeakerTestPending] = React.useState(false);
  const [speakerTestError, setSpeakerTestError] = React.useState<string | null>(null);

  // The picker says why it is empty, so "blocked" never reads as "not
  // detected". Both derive from the same per-kind status as the banner.
  const cameraPlaceholder = getDevicePickerPlaceholder("camera", devices.cameraStatus);
  const microphonePlaceholder = getDevicePickerPlaceholder("microphone", devices.microphoneStatus);

  const concreteVideoDevices = devices.videoDevices.filter((d) => d.deviceId !== "default");
  const concreteAudioDevices = devices.audioDevices.filter((d) => d.deviceId !== "default");
  const concreteAudioOutputDevices = devices.audioOutputDevices.filter(
    (d) => d.deviceId !== "default",
  );

  const handleSpeakerTest = async () => {
    if (speakerTestPending) return;
    setSpeakerTestPending(true);
    setSpeakerTestError(null);
    try {
      await playSpeakerTestTone(devices.selectedAudioOutputDevice);
    } catch {
      setSpeakerTestError("Could not play the test sound on this speaker.");
    } finally {
      setSpeakerTestPending(false);
    }
  };

  return (
    <div {...stylex.props(stack.x4, sx)}>
      <PreJoinDeviceNotice devices={devices} />

      <Field id={`${idPrefix}-camera`} label="Camera">
        <Select
          aria-labelledby={`${idPrefix}-camera`}
          value={
            devices.videoDevices.length === 0
              ? ""
              : (devices.selectedVideoDevice ?? SYSTEM_DEFAULT_VIDEO_DEVICE)
          }
          onValueChange={(v) =>
            devices.onVideoDeviceChange(
              v === SYSTEM_DEFAULT_VIDEO_DEVICE ? undefined : (v ?? undefined),
            )
          }
          disabled={devices.videoDevices.length === 0 || devices.isLoadingDevices}
          placeholder={cameraPlaceholder}
          options={
            devices.videoDevices.length === 0
              ? [{ label: cameraPlaceholder, value: "" }]
              : [
                  { label: "System default", value: SYSTEM_DEFAULT_VIDEO_DEVICE },
                  ...concreteVideoDevices.map((d) => ({
                    label: d.label || `Camera ${d.deviceId.slice(0, 8)}`,
                    value: d.deviceId,
                  })),
                ]
          }
        />
      </Field>

      <Field id={`${idPrefix}-microphone`} label="Microphone">
        <Select
          aria-labelledby={`${idPrefix}-microphone`}
          value={
            devices.audioDevices.length === 0
              ? ""
              : (devices.selectedAudioDevice ?? SYSTEM_DEFAULT_AUDIO_DEVICE)
          }
          onValueChange={(v) =>
            devices.onAudioDeviceChange(
              v === SYSTEM_DEFAULT_AUDIO_DEVICE ? undefined : (v ?? undefined),
            )
          }
          disabled={devices.audioDevices.length === 0 || devices.isLoadingDevices}
          placeholder={microphonePlaceholder}
          options={
            devices.audioDevices.length === 0
              ? [{ label: microphonePlaceholder, value: "" }]
              : [
                  { label: "System default", value: SYSTEM_DEFAULT_AUDIO_DEVICE },
                  ...concreteAudioDevices.map((d) => ({
                    label: d.label || `Mic ${d.deviceId.slice(0, 8)}`,
                    value: d.deviceId,
                  })),
                ]
          }
        />
        <MicrophoneLevelMeter
          track={devices.audioPreviewTrack}
          enabled={devices.audioEnabled}
        />
      </Field>

      <Field id={`${idPrefix}-speaker`} label="Speaker">
        <div {...stylex.props(styles.speakerRow)}>
          <div {...stylex.props(styles.speakerSelect)}>
            {canSelectAudioOutput() && devices.audioOutputDevices.length > 0 ? (
              <Select
                aria-labelledby={`${idPrefix}-speaker`}
                value={devices.selectedAudioOutputDevice ?? SYSTEM_DEFAULT_AUDIO_OUTPUT}
                onValueChange={(value) =>
                  devices.onAudioOutputDeviceChange(
                    value === SYSTEM_DEFAULT_AUDIO_OUTPUT ? undefined : (value ?? undefined),
                  )
                }
                options={[
                  { label: "System default", value: SYSTEM_DEFAULT_AUDIO_OUTPUT },
                  ...concreteAudioOutputDevices.map((device) => ({
                    label: device.label || `Speaker ${device.deviceId.slice(0, 8)}`,
                    value: device.deviceId,
                  })),
                ]}
              />
            ) : (
              <div {...stylex.props(styles.speakerFallback)}>
                System default
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => void handleSpeakerTest()}
            disabled={speakerTestPending}
            {...stylex.props(pressable.base, motion.tint, focus.ring, styles.speakerTest)}
          >
            <Volume2 size={16} />
            {speakerTestPending ? "Playing…" : "Test"}
          </button>
        </div>
        {speakerTestError && (
          <p {...stylex.props(styles.speakerTestError)}>{speakerTestError}</p>
        )}
      </Field>

      <PreJoinCaptionRow
        language={captionLanguage}
        onLanguageChange={onCaptionLanguageChange}
      />
    </div>
  );
}

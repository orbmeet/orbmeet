import { ink, live, neutral } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import * as React from "react";

const styles = stylex.create({
  row: { marginTop: space.s2, display: "flex", alignItems: "center", gap: space.s2 },
  track: {
    height: 6,
    flexGrow: 1,
    overflow: "hidden",
    borderRadius: radii.pill,
    backgroundColor: neutral.n200,
  },
  /**
   * Driven by `transform: scaleX()` written straight to the node from a
   * requestAnimationFrame loop — never through React state. At 60fps a
   * re-render per frame would cost more than the meter is worth, and a
   * composited transform is the one property that can keep up.
   */
  fill: {
    height: "100%",
    transformOrigin: "left",
    borderRadius: radii.pill,
    transitionProperty: "transform, background-color",
    transitionDuration: "80ms",
    transitionTimingFunction: "linear",
  },
  fillLive: { backgroundColor: live.l500 },
  fillIdle: { backgroundColor: neutral.n300 },
  caption: {
    width: 56,
    textAlign: "end",
    fontSize: text.xs2,
    color: ink.muted,
  },
});

interface MicrophoneLevelMeterProps {
  track: MediaStreamTrack | null;
  enabled: boolean;
}

export function normalizeMicrophoneLevel(rms: number): number {
  return Math.min(1, Math.max(0, (rms - 0.008) * 10));
}

export function MicrophoneLevelMeter({
  track,
  enabled,
}: MicrophoneLevelMeterProps) {
  const fillRef = React.useRef<HTMLDivElement>(null);
  const meterRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const fill = fillRef.current;
    const meter = meterRef.current;
    if (!enabled || !track || !fill || !meter) {
      fill?.style.setProperty("transform", "scaleX(0)");
      meter?.setAttribute("aria-valuenow", "0");
      return;
    }

    const AudioContextCtor =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextCtor) return;

    const context = new AudioContextCtor();
    const analyser = context.createAnalyser();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const samples = new Float32Array(256);
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    void context.resume().catch(() => undefined);

    let frame = 0;
    const update = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / samples.length);
      const level = normalizeMicrophoneLevel(rms);
      const percentage = Math.round(level * 100);
      fill.style.transform = `scaleX(${level})`;
      meter.setAttribute("aria-valuenow", String(percentage));
      frame = window.requestAnimationFrame(update);
    };
    frame = window.requestAnimationFrame(update);

    return () => {
      window.cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      void context.close();
    };
  }, [enabled, track]);

  return (
    <div {...stylex.props(styles.row)}>
      <div
        ref={meterRef}
        role="meter"
        aria-label="Microphone input level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={0}
        {...stylex.props(styles.track)}
      >
        <div
          ref={fillRef}
          {...stylex.props(styles.fill, enabled && track ? styles.fillLive : styles.fillIdle)}
        />
      </div>
      <span {...stylex.props(styles.caption)}>
        {!enabled ? "Muted" : track ? "Mic level" : "Starting…"}
      </span>
    </div>
  );
}

import { isKey } from "@orbmeet/ui/keyboard";
import { motion, pressable } from "@orbmeet/ui/styles/atoms";
import { accent, danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import { dockPopover } from "@/modules/meetings/client/meeting-styles";
import {
  STREAMING_DESTINATIONS,
  readStreamingPreference,
  writeStreamingPreference,
} from "@/modules/meetings/client/streaming-preferences";
import type { StreamingPlatform } from "@/modules/meetings/contract/schemas";
import { PLATFORM_META } from "./streaming-platform-icons";

const styles = stylex.create({
  heading: {
    marginTop: 0,
    marginBottom: space.s3,
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: neutral.n800,
  },
  sheetLabel: {
    display: "block",
    marginTop: 0,
    marginBottom: space.s1_5,
    fontSize: text.xs,
    fontWeight: weight.medium,
    letterSpacing: tracking.wide,
    textTransform: "uppercase",
    color: neutral.n500,
  },
  /** Eight destinations, four to a row: two tidy rows at any panel width. */
  grid: {
    marginBottom: space.s3,
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: space.s1_5,
  },
  gridSheet: {
    marginBottom: space.s4,
    gap: space.s2,
  },
  destination: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s1,
    borderRadius: radii.control,
    borderWidth: 0,
    paddingInline: space.s2,
    paddingBlock: space.s2,
    fontFamily: "inherit",
    fontSize: text.xs,
    fontWeight: weight.medium,
  },
  destinationSheet: {
    paddingBlock: space.s2_5,
    fontWeight: weight.semibold,
  },
  destinationIdle: {
    backgroundColor: { default: neutral.n100, [env.hoverable]: { default: neutral.n100, ":hover": neutral.n200 } },
    color: neutral.n600,
  },
  /**
   * The chosen destination wears its own brand colour, so the form says which
   * platform is about to receive the stream without reading a label.
   */
  destinationChosen: (brand: string) => ({
    backgroundColor: brand,
    color: ink.onDark,
    boxShadow: `0 0 0 1px ${surface.raised}, 0 0 0 3px ${brand}`,
  }),
  key: { marginBottom: space.s2 },
  sheetKeyInput: {
    marginBottom: space.s4,
    height: 48,
    width: "100%",
    borderRadius: radii.control,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: neutral.n200, ":focus": accent.a500 },
    backgroundColor: surface.raised,
    paddingInline: space.s3,
    fontFamily: "inherit",
    fontSize: text.base,
    color: neutral.n900,
    outlineStyle: "none",
    boxShadow: { default: null, ":focus": `0 0 0 2px color-mix(in oklab, ${accent.a500} 20%, transparent)` },
    "::placeholder": { color: neutral.n400 },
  },
  start: {
    backgroundColor: { default: danger.d500, [env.hoverable]: { default: danger.d500, ":hover:not(:disabled)": danger.d600 } },
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": 0.4 },
  },
  sheetStart: {
    height: 48,
    width: "100%",
    borderRadius: radii.control,
    backgroundColor: { default: danger.d500, ":active": danger.d600 },
    fontSize: text.sm,
    fontWeight: weight.semibold,
    color: ink.onDark,
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": 0.4 },
  },
});

/** The go-live destination + stream-key form, used in both the desktop popover and mobile sheet. */
export function GoLiveForm({
  onGoLive,
  onDone,
  variant = "popover",
}: {
  onGoLive?: (platform: StreamingPlatform, streamKey: string) => Promise<void>;
  onDone?: () => void;
  variant?: "popover" | "sheet";
}) {
  const [selectedPlatform, setSelectedPlatform] = useState<StreamingPlatform>(
    () => readStreamingPreference()?.platform ?? "twitch",
  );
  const [streamKey, setStreamKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const streamKeyId = useId();
  const isSheet = variant === "sheet";
  const selectedDestination =
    STREAMING_DESTINATIONS.find((d) => d.id === selectedPlatform) ?? STREAMING_DESTINATIONS[0];

  const handleStart = async () => {
    if (!streamKey.trim() || !onGoLive || submitting) return;
    setSubmitting(true);
    try {
      const trimmedStreamKey = streamKey.trim();
      writeStreamingPreference({ platform: selectedPlatform });
      await onGoLive(selectedPlatform, trimmedStreamKey);
      onDone?.();
    } catch {
      // The meeting hook has already surfaced the operational error. Keeping the
      // form mounted preserves the stream key so the user can correct/retry it.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <p {...stylex.props(isSheet ? styles.sheetLabel : styles.heading)}>
        {isSheet ? "Destination" : "Go live to"}
      </p>
      <div {...stylex.props(styles.grid, isSheet && styles.gridSheet)}>
        {STREAMING_DESTINATIONS.map((destination) => {
          const meta = PLATFORM_META[destination.id];
          return (
            <button
              key={destination.id}
              type="button"
              onClick={() => setSelectedPlatform(destination.id)}
              {...stylex.props(
                pressable.base,
                motion.tint,
                styles.destination,
                isSheet && styles.destinationSheet,
                selectedPlatform === destination.id
                  ? styles.destinationChosen(meta.color)
                  : styles.destinationIdle,
              )}
            >
              {meta.icon}
              {meta.label}
            </button>
          );
        })}
      </div>
      {isSheet && (
        <label htmlFor={streamKeyId} {...stylex.props(styles.sheetLabel)}>
          {selectedDestination.keyLabel}
        </label>
      )}
      <input
        id={isSheet ? streamKeyId : undefined}
        type="text"
        inputMode={isSheet ? "text" : undefined}
        aria-label={isSheet ? undefined : selectedDestination.keyLabel}
        placeholder={selectedDestination.placeholder}
        value={streamKey}
        onChange={(e) => setStreamKey(e.target.value)}
        onKeyDown={(e) => { if (isKey(e.nativeEvent, "Enter")) void handleStart(); }}
        {...stylex.props(isSheet ? [styles.sheetKeyInput, motion.tint] : [dockPopover.field, styles.key])}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={() => void handleStart()}
        disabled={!streamKey.trim() || submitting}
        {...stylex.props(
          pressable.base,
          motion.tint,
          isSheet ? styles.sheetStart : [dockPopover.action, styles.start],
        )}
      >
        {submitting ? "Starting…" : isSheet ? "Go live" : "Go Live"}
      </button>
    </div>
  );
}

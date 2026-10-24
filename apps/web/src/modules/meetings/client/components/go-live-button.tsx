import { motion, pressable } from "@orbmeet/ui/styles/atoms";
import { danger, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { dockPopover } from "@/modules/meetings/client/meeting-styles";
import type { StreamingPlatform } from "@/modules/meetings/contract/schemas";

const styles = stylex.create({
  heading: {
    marginTop: 0,
    marginBottom: space.s3,
    fontSize: text.xs,
    fontWeight: weight.semibold,
    color: neutral.n800,
  },
  /** Eight destinations, four to a row: two tidy rows at any panel width. */
  grid: {
    marginBottom: space.s3,
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: space.s1_5,
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
  start: {
    backgroundColor: { default: danger.d500, [env.hoverable]: { default: danger.d500, ":hover:not(:disabled)": danger.d600 } },
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": 0.4 },
  },
});
import {
  STREAMING_DESTINATIONS,
  readStreamingPreference,
  writeStreamingPreference,
} from "@/modules/meetings/client/streaming-preferences";
import { PLATFORM_META } from "./streaming-platform-icons";

/** The go-live destination + stream-key form, embeddable outside the button's own popover. */
export function GoLiveForm({
  onGoLive,
  onDone,
}: {
  onGoLive?: (platform: StreamingPlatform, streamKey: string) => Promise<void>;
  onDone?: () => void;
}) {
  const [selectedPlatform, setSelectedPlatform] = useState<StreamingPlatform>(
    () => readStreamingPreference()?.platform ?? "twitch",
  );
  const [streamKey, setStreamKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const selectedDestination = STREAMING_DESTINATIONS.find((d) => d.id === selectedPlatform) ?? STREAMING_DESTINATIONS[0];

  const handleStart = async () => {
    if (!streamKey.trim() || !onGoLive) return;
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
      <p {...stylex.props(styles.heading)}>Go live to</p>
      <div {...stylex.props(styles.grid)}>
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
      <input
        type="text"
        aria-label={selectedDestination.keyLabel}
        placeholder={selectedDestination.placeholder}
        value={streamKey}
        onChange={(e) => setStreamKey(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void handleStart(); }}
        {...stylex.props(dockPopover.field, styles.key)}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={() => void handleStart()}
        disabled={!streamKey.trim() || submitting}
        {...stylex.props(pressable.base, motion.tint, dockPopover.action, styles.start)}
      >
        {submitting ? "Starting…" : "Go Live"}
      </button>
    </div>
  );
}

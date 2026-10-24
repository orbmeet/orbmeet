import * as stylex from "@stylexjs/stylex";
import { Radio } from "lucide-react";

import type { StreamingPlatform } from "@/modules/meetings/contract/schemas";

/**
 * Every platform mark is drawn at one size, so a row of them lines up whatever
 * mix of glyphs it contains.
 */
const styles = stylex.create({
  mark: { height: 16, width: 16 },
});

export const PLATFORM_META: Record<StreamingPlatform, { label: string; color: string; icon: React.ReactNode }> = {
  twitch: {
    label: "Twitch",
    color: "#9146FF",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...stylex.props(styles.mark)}>
        <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z" />
      </svg>
    ),
  },
  youtube: {
    label: "YouTube",
    color: "#FF0000",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...stylex.props(styles.mark)}>
        <path d="M23.495 6.205a3.007 3.007 0 0 0-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 0 0 .527 6.205a31.247 31.247 0 0 0-.522 5.805 31.247 31.247 0 0 0 .522 5.783 3.007 3.007 0 0 0 2.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 0 0 2.088-2.088 31.247 31.247 0 0 0 .5-5.783 31.247 31.247 0 0 0-.5-5.805zM9.609 15.601V8.408l6.264 3.602z" />
      </svg>
    ),
  },
  facebook: {
    label: "Facebook",
    color: "#1877F2",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...stylex.props(styles.mark)}>
        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
      </svg>
    ),
  },
  kick: {
    label: "Kick",
    color: "#53fc18",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...stylex.props(styles.mark)}>
        <path d="M4 4h5v6.2L14.6 4H21l-7.2 7.6L21.5 20h-6.7L9 13.3V20H4z" />
      </svg>
    ),
  },
  linkedin: {
    label: "LinkedIn",
    color: "#0A66C2",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...stylex.props(styles.mark)}>
        <path d="M5.4 8.7h3.5V20H5.4zM7.2 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4m4.1 4.7h3.4v1.5h.1c.5-.9 1.7-1.8 3.5-1.8 3.7 0 4.4 2.4 4.4 5.6v6h-3.5v-5.3c0-1.3 0-2.9-1.8-2.9s-2.1 1.4-2.1 2.8V20h-3.5V8.7z" />
      </svg>
    ),
  },
  instagram: {
    label: "Instagram",
    color: "#E1306C",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...stylex.props(styles.mark)}>
        <rect x="4.5" y="4.5" width="15" height="15" rx="4.5" stroke="currentColor" strokeWidth="2.1" />
        <circle cx="12" cy="12" r="3.4" stroke="currentColor" strokeWidth="2.1" />
        <circle cx="16.8" cy="7.2" r="1.1" fill="currentColor" />
      </svg>
    ),
  },
  tiktok: {
    label: "TikTok",
    color: "#111827",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...stylex.props(styles.mark)}>
        <path d="M14.6 3h3.1c.2 1.4 1 2.6 2.1 3.5.7.5 1.4.9 2.2 1v3.3a7.8 7.8 0 0 1-4.2-1.3v5.9c0 3.2-2.6 5.8-5.9 5.8A5.7 5.7 0 0 1 6 15.6c0-3.5 3-6.1 6.4-5.7v3.4a2.5 2.5 0 0 0-3 2.4 2.5 2.5 0 0 0 2.5 2.5 2.4 2.4 0 0 0 2.5-2.5V3z" />
      </svg>
    ),
  },
  x: {
    label: "X",
    color: "#18181b",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...stylex.props(styles.mark)}>
        <path d="M4.2 4h4.9l3.6 5.1L17.2 4h2.7l-6 6.9L20.2 20h-4.9l-4-5.7L6.3 20H3.6l6.5-7.5zM7 5.6l9.1 12.8h1.3L8.3 5.6z" />
      </svg>
    ),
  },
  custom: {
    label: "Custom",
    color: "#57534e",
    icon: <Radio size={16} strokeWidth={1.75} />,
  },
};

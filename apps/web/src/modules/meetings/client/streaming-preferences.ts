import type { StreamingPlatform } from "@/modules/meetings/contract/schemas";

const STORAGE_KEY = "orbmeet.streaming.destination.v1";

export type StreamingPreference = {
  platform: StreamingPlatform;
};

export const STREAMING_DESTINATIONS: Array<{
  id: StreamingPlatform;
  label: string;
  keyLabel: string;
  placeholder: string;
}> = [
  {
    id: "twitch",
    label: "Twitch",
    keyLabel: "Stream key",
    placeholder: "Twitch stream key",
  },
  {
    id: "youtube",
    label: "YouTube",
    keyLabel: "Stream key",
    placeholder: "YouTube stream key",
  },
  {
    id: "facebook",
    label: "Facebook",
    keyLabel: "Stream key",
    placeholder: "Facebook stream key",
  },
  {
    id: "kick",
    label: "Kick",
    keyLabel: "Stream key",
    placeholder: "Kick stream key",
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    keyLabel: "RTMP URL",
    placeholder: "rtmps://server.example.com/app/stream-key",
  },
  {
    id: "instagram",
    label: "Instagram",
    keyLabel: "RTMP URL",
    placeholder: "rtmps://server.example.com/app/stream-key",
  },
  {
    id: "tiktok",
    label: "TikTok",
    keyLabel: "RTMP URL",
    placeholder: "rtmps://server.example.com/app/stream-key",
  },
  {
    id: "x",
    label: "X",
    keyLabel: "RTMP URL",
    placeholder: "rtmps://server.example.com/app/stream-key",
  },
  {
    id: "custom",
    label: "Custom",
    keyLabel: "RTMP URL",
    placeholder: "rtmps://server.example.com/app/stream-key",
  },
];

const DESTINATION_IDS = new Set<StreamingPlatform>(STREAMING_DESTINATIONS.map((destination) => destination.id));

export function readStreamingPreference(): StreamingPreference | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StreamingPreference>;
    if (!parsed.platform || !DESTINATION_IDS.has(parsed.platform)) return null;
    return {
      platform: parsed.platform,
    };
  } catch {
    return null;
  }
}

export function writeStreamingPreference(preference: StreamingPreference) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Storage can be disabled in private browsing or locked-down environments.
  }
}

import type { MediaNode } from "@/platform/realtime/nodes";

/** The one media node tests configure; seed Meetings with `mediaNodeId: TEST_MEDIA_NODE.id`. */
export const TEST_MEDIA_NODE: MediaNode = {
  id: "test-node",
  region: "test-node",
  weight: 1,
  url: "wss://livekit.example.com",
  capacity: 100,
  apiKey: "key",
  apiSecret: "secret",
};

/** TEST_MEDIA_NODE's entry in NODES. */
export const TEST_MEDIA_NODE_ENTRY = {
  media: {
    url: TEST_MEDIA_NODE.url,
    capacity: TEST_MEDIA_NODE.capacity,
    keys: { [TEST_MEDIA_NODE.apiKey]: TEST_MEDIA_NODE.apiSecret },
  },
};

/** Env fragment that configures TEST_MEDIA_NODE as the only node. */
export const TEST_MEDIA_ENV = {
  NODES: JSON.stringify({ [TEST_MEDIA_NODE.id]: TEST_MEDIA_NODE_ENTRY }),
} as const;

import type { Secrets } from "./secrets.ts";

export const INVENTORY = {
  app_url: "https://app.example.com",
  nodes: {
    sg1: { ssh: "ubuntu@203.0.113.10", ipv4: "203.0.113.10", ipv6: "2001:db8::10",
      interface: "enp0s6", services: ["media", "whiteboard"], weight: 2,
      memory: "16g", media_capacity: 60 },
    my1: { ssh: "root@203.0.113.20", ipv4: "203.0.113.20", interface: "eth0",
      services: ["media"], memory: "8g", media_capacity: 30,
      memory_limits: { livekit: "2g", egress: "3g", transcription: "1536m" } } as Record<string, unknown>,
  },
};

/** The fixture inventory with some nodes' fields changed. */
export function inventory(changes: Record<string, Record<string, unknown>> = {}): typeof INVENTORY {
  const data = structuredClone(INVENTORY) as typeof INVENTORY & { nodes: Record<string, Record<string, unknown>> };
  for (const [name, fields] of Object.entries(changes)) data.nodes[name] = { ...data.nodes[name], ...fields };
  return data;
}

export function fakeSecrets(names = ["sg1", "my1"]): Secrets {
  // Delimited, so no fake value contains another (R2_… is a suffix of EGRESS_R2_…).
  const value = (key: string) => `<${key}>${"x".repeat(40)}`;
  return {
    R2_ACCESS_KEY_ID: value("R2_ACCESS_KEY_ID"),
    R2_SECRET_ACCESS_KEY: value("R2_SECRET_ACCESS_KEY"),
    R2_ACCOUNT_ID: value("R2_ACCOUNT_ID"),
    R2_BUCKET_NAME: value("R2_BUCKET_NAME"),
    EGRESS_R2_ACCESS_KEY_ID: value("EGRESS_R2_ACCESS_KEY_ID"),
    EGRESS_R2_SECRET_ACCESS_KEY: value("EGRESS_R2_SECRET_ACCESS_KEY"),
    DEEPGRAM_API_KEY: value("DEEPGRAM_API_KEY"),
    AXIOM_TOKEN: `xaat-${"x".repeat(36)}`,
    nodes: Object.fromEntries(names.map((name) => [name, {
      LIVEKIT_KEYS: { [`${name}-app`]: `${name}-app-${"s".repeat(40)}` },
      LIVEKIT_EGRESS_API_KEY: `${name}-egress`,
      LIVEKIT_EGRESS_API_SECRET: `${name}-egress-${"s".repeat(40)}`,
      REDIS_PASSWORD: `${name}-redis-${"p".repeat(40)}`,
      LIVEKIT_TRANSCRIPTION_API_KEY: `${name}-transcription`,
      LIVEKIT_TRANSCRIPTION_API_SECRET: `${name}-transcription-${"s".repeat(40)}`,
      TRANSCRIPTION_INTERNAL_KEY_ID: `${name}-ingest`,
      TRANSCRIPTION_INTERNAL_SECRET: `${name}-ingest-${"s".repeat(40)}`,
      WHITEBOARD_JWT_KEYS: { [`${name}-jwt`]: `${name}-jwt-${"s".repeat(40)}` },
      WHITEBOARD_COMMAND_KEYS: { [`${name}-command`]: `${name}-command-${"s".repeat(40)}` },
      WHITEBOARD_CALLBACK_KEYS: { [`${name}-callback`]: `${name}-callback-${"s".repeat(40)}` },
    }])),
  };
}

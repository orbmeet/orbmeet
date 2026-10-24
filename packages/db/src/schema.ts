// Public schema barrel. The tables live in per-domain modules under
// ./schema/, in dependency order: a module may import from the ones above it
// and never from the ones below. Drizzle's migration generator and every
// application import resolve through this file.

export * from "./schema/identity.ts";
export * from "./schema/organizations.ts";
export * from "./schema/spaces.ts";
export * from "./schema/assets.ts";
export * from "./schema/meeting-links.ts";
export * from "./schema/meetings.ts";
export * from "./schema/scheduling.ts";
export * from "./schema/contacts.ts";
export * from "./schema/transcripts.ts";
export * from "./schema/summaries.ts";
export * from "./schema/whiteboards.ts";
export * from "./schema/artifacts.ts";
export * from "./schema/platform.ts";

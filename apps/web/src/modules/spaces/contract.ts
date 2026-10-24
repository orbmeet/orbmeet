const SPACE_TABS = ["meetings", "whiteboards", "people", "files", "settings"] as const;

export type SpaceTab = (typeof SPACE_TABS)[number];

export function parseSpaceTab(value: unknown): SpaceTab | undefined {
  if (typeof value !== "string") return undefined;
  return (SPACE_TABS as readonly string[]).includes(value) ? value as SpaceTab : undefined;
}

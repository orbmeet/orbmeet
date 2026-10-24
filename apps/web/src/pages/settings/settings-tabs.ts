const SETTINGS_TAB_IDS = [
  "profile",
  "privacy",
  "plan-&-billing",
  "organization",
  "security",
  "active-sessions",
  "linked-accounts",
  "notifications",
  "developer-api",
  "danger-zone",
] as const;

export type SettingsTabId = (typeof SETTINGS_TAB_IDS)[number];

export function isSettingsTabId(value: unknown): value is SettingsTabId {
  return typeof value === "string" && (SETTINGS_TAB_IDS as readonly string[]).includes(value);
}

/**
 * Settings is one page of what people change, and two pages of what they
 * rarely do. A `?tab=` from before keeps working: it opens the page its
 * section now lives on, scrolled to it.
 */
export type SettingsPageId = "settings" | "account" | "billing";

const PAGE_OF: Record<SettingsTabId, SettingsPageId> = {
  profile: "settings",
  // Privacy held one choice, Orb's: whether your meetings are transcribed.
  privacy: "settings",
  // Notifications was a placeholder; an old link to it lands on the page it was on.
  notifications: "settings",
  security: "account",
  "linked-accounts": "account",
  "active-sessions": "account",
  "developer-api": "account",
  "danger-zone": "account",
  "plan-&-billing": "billing",
  organization: "billing",
};

export function settingsPageOf(tab: SettingsTabId | undefined): SettingsPageId {
  return tab ? PAGE_OF[tab] : "settings";
}

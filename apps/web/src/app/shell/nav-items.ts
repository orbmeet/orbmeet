import { CalendarDays, House, Layers, Users } from "lucide-react";

/**
 * Where the authenticated app goes.
 *   Home     — start or join, what's next, what just happened
 *   Calendar — what is planned, and where a meeting is scheduled
 *   Library  — every past meeting, board and recording, searchable
 * Spaces are not a destination of their own in the rail: each one is listed
 * there by name. On a phone, which has no room for that list, they are one tab.
 * A permanent meeting link is a property of Home or a Space, never a page.
 */
export const mainNavItems = [
  { to: "/home" as const, label: "Home", icon: House },
  { to: "/calendar" as const, label: "Calendar", icon: CalendarDays },
  { to: "/library" as const, label: "Library", icon: Layers },
] as const;

/**
 * `within` is a path prefix that also counts as being in a tab: a space's own
 * page lives at `/space/…`, and is still somewhere under Spaces.
 */
export const phoneNavItems = [
  ...mainNavItems,
  { to: "/spaces" as const, label: "Spaces", icon: Users, within: "/space/" },
] as const;

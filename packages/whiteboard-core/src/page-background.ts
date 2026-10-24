import { T } from "@tldraw/validate";

export const PAGE_BACKGROUNDS = [
  "white", "white-dots", "white-lines", "white-grid",
  "dark", "dark-dots", "dark-lines", "dark-grid",
] as const;

export type PageBackground = (typeof PAGE_BACKGROUNDS)[number];
export const DEFAULT_PAGE_BACKGROUND: PageBackground = "white";

export interface PageBackgroundOption {
  value: PageBackground;
  label: string;
  isDark: boolean;
}

export const PAGE_BACKGROUND_OPTIONS: PageBackgroundOption[] = [
  { value: "white", label: "Plain", isDark: false },
  { value: "white-dots", label: "Dots", isDark: false },
  { value: "white-lines", label: "Lines", isDark: false },
  { value: "white-grid", label: "Grid", isDark: false },
  { value: "dark", label: "Dark", isDark: true },
  { value: "dark-dots", label: "Dark Dots", isDark: true },
  { value: "dark-lines", label: "Dark Lines", isDark: true },
  { value: "dark-grid", label: "Dark Grid", isDark: true },
];

const VALID_BACKGROUNDS: ReadonlySet<string> = new Set(PAGE_BACKGROUNDS);

export function parsePageBackground(value: unknown): PageBackground {
  return typeof value === "string" && VALID_BACKGROUNDS.has(value)
    ? (value as PageBackground)
    : DEFAULT_PAGE_BACKGROUND;
}

export const pageBackgroundValidator = T.unknown.refine(parsePageBackground);

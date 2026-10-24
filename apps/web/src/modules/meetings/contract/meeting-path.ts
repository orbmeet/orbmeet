import { MEETING_CODE_SOURCE } from "@/modules/meetings/contract/constants";

const MEETING_CODE_RE = new RegExp(`^${MEETING_CODE_SOURCE}$`);
const MEETING_PATH_RE = new RegExp(`^/(${MEETING_CODE_SOURCE})$`);

export function isMeetingCode(value: string): boolean {
  return MEETING_CODE_RE.test(value);
}

export function extractMeetingCodeFromPathname(pathname: string): string | null {
  const match = MEETING_PATH_RE.exec(pathname);
  return match?.[1] ?? null;
}

export function isMeetingPathname(pathname: string): boolean {
  return extractMeetingCodeFromPathname(pathname) !== null;
}

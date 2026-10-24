import { MEETING_CODE_SOURCE } from "./constants";

// Meeting entry documents are addressed by a meeting-link credential (codes like
// `/abc-defg-hij`, shape defined by MEETING_CODE_GROUPS) and the recorder
// surface. Several layers treat them specially — the Worker applies the
// meeting CSP, and the PWA suppresses install/update interruptions — so the
// definition lives here once.
const MEETING_CODE_PATH = new RegExp(`^/(?:${MEETING_CODE_SOURCE})(?:/|$)`);

/** True for document paths under a meeting code (`/abc-defg-hij[/...]`). */
function isMeetingCodePath(pathname: string): boolean {
  return MEETING_CODE_PATH.test(pathname);
}

/** True for document paths that render a live meeting or recorder surface. */
export function isMeetingDocumentPath(pathname: string): boolean {
  return (pathname === "/recorder" || pathname.startsWith("/recorder/"))
    || isMeetingCodePath(pathname);
}

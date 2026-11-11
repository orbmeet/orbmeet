import { isMeetingDocumentPath } from "@/modules/meetings/contract/paths";

/**
 * A meeting and the rest of the app are served as different documents, with
 * different security headers (`documentSecurityConfig`): only a meeting's may
 * use the camera, microphone and screen and reach the media nodes, and only
 * the app's may load the checkout. Headers belong to the document, so a
 * client-side navigation across that line would run the page under the wrong
 * ones — a meeting that cannot open the microphone, a Home whose checkout
 * cannot load. Such a navigation must load a new document instead.
 */
export function crossesDocumentBoundary(documentPathname: string, destinationPathname: string): boolean {
  return isMeetingDocumentPath(documentPathname) !== isMeetingDocumentPath(destinationPathname);
}

/** The path this document was served for; null on the server. */
export const DOCUMENT_PATHNAME: string | null = typeof window === "undefined" ? null : window.location.pathname;

/**
 * Open `url` in a new tab that has no handle on this page. With `noopener`
 * the browser hands back no window, so a blocked popup cannot be detected:
 * call this from a click, or soon enough after one that the browser still
 * counts it (Chrome and Firefox allow 5 seconds, WebKit 10 across a fetch).
 */
export function openExternalUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

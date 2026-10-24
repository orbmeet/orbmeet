export function openExternalUrl(url: string): WindowProxy | null {
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (opened) {
    try {
      opened.opener = null;
    } catch {
      // Some browsers disallow touching opener on cross-origin windows.
    }
  }
  return opened;
}

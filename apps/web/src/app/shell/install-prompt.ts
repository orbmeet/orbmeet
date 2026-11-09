/* The browser's install prompt, kept apart from the offer's UI: the root route
 * captures it on every page, so what it imports loads on every page. */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/**
 * `beforeinstallprompt` fires once, early, on whatever page the visit started
 * on — usually before the authed shell that shows the offer has mounted. So the
 * event is captured at the root (`PwaStatus`) into this module-level store, and
 * the offer reads it whenever it appears.
 */
let capturedPrompt: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

export function emit() {
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPrompt() {
  return capturedPrompt;
}

export function clearCapturedPrompt() {
  capturedPrompt = null;
}

/** Starts capturing the install prompt. Returns the cleanup. */
export function captureInstallPrompt(): () => void {
  // Capturing keeps the offer available; whether it is *shown* is the
  // dismissal record's call, so this must not clear it.
  const handlePrompt = (event: Event) => {
    event.preventDefault();
    capturedPrompt = event as InstallPromptEvent;
    emit();
  };
  const handleInstalled = () => {
    capturedPrompt = null;
    emit();
  };
  window.addEventListener("beforeinstallprompt", handlePrompt);
  window.addEventListener("appinstalled", handleInstalled);
  return () => {
    window.removeEventListener("beforeinstallprompt", handlePrompt);
    window.removeEventListener("appinstalled", handleInstalled);
  };
}

import { Button } from "@orbmeet/ui/react";
import { accent, border, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { bp } from "@orbmeet/ui/tokens/media.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { Download, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getPlatformEnvironment,
  installsViaShareSheet,
  isStandaloneDisplayMode,
} from "@/lib/browser-capabilities";

/* ── The captured browser prompt ─────────────────────────────────────────── */

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

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getPrompt() {
  return capturedPrompt;
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

/* ── Dismissal ───────────────────────────────────────────────────────────── */

// Dismissing the install offer means "stop asking", not "stop asking until I
// reload". Both variants share the record: the iOS hint has no browser-driven
// trigger to re-raise it, and Chrome re-fires `beforeinstallprompt` on most
// visits, so without this the offer returned on every page load.
const INSTALL_OFFER_DISMISSED_KEY = "orbmeet.pwa.install-offer-dismissed";

let dismissed = false;

function readDismissed(): boolean {
  try {
    return localStorage.getItem(INSTALL_OFFER_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function dismiss() {
  dismissed = true;
  try {
    localStorage.setItem(INSTALL_OFFER_DISMISSED_KEY, "1");
  } catch {
    // Storage can be unavailable (private mode, quota); the offer then simply
    // reappears next visit.
  }
  emit();
}

function getDismissed() {
  return dismissed;
}

/* ── The offer ───────────────────────────────────────────────────────────── */

const styles = stylex.create({
  root: {
    display: "flex",
    gap: space.s3,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: border.subtle,
    backgroundColor: surface.raised,
    fontSize: text.sm,
    lineHeight: leading.sm,
    color: ink.body,
  },
  /**
   * In the content column on a phone and tablet: a strip at the top of the
   * page, in the flow, so it pushes the page down rather than covering it.
   */
  strip: {
    display: { default: "flex", [bp.lg]: "none" },
    alignItems: "center",
    marginBottom: space.s6,
    borderRadius: radii.card,
    paddingBlock: space.s2_5,
    paddingInlineStart: space.s4,
    paddingInlineEnd: space.s2,
  },
  /** In the desktop sidebar: a small card above the account controls. */
  /**
   * The rail's placement: one quiet row above the account controls, not a
   * card. The rail is navigation; an offer nobody asked for must not outweigh
   * it.
   */
  card: {
    display: { default: "none", [bp.lg]: "flex" },
    alignItems: "center",
    gap: space.s2,
    borderWidth: 0,
    borderRadius: radii.control,
    backgroundColor: neutral.n50,
    paddingBlock: space.s1,
    paddingInlineStart: space.s3,
    paddingInlineEnd: space.s1,
  },
  rowAction: {
    flexGrow: 1,
    minWidth: 0,
    justifyContent: "flex-start",
    paddingInline: 0,
    color: ink.strong,
    backgroundColor: "transparent",
    boxShadow: "none",
  },
  rowHint: { flexGrow: 1, minWidth: 0, margin: 0, fontSize: text.xs, lineHeight: leading.xs, color: ink.body },
  glyph: { flexShrink: 0, color: accent.a600 },
  message: { flexGrow: 1, minWidth: 0 },
  title: { margin: 0, fontWeight: weight.semibold, color: ink.strong },
  hint: { margin: 0, fontSize: text.xs, lineHeight: leading.xs, color: ink.muted },
  actions: { display: "flex", flexShrink: 0, alignItems: "center", gap: space.s1 },
  close: { color: neutral.n500 },
});

/**
 * The offer to install Orb Meet as an app.
 *
 * It used to be a fixed overlay rendered from the root, and so covered
 * whatever happened to be beneath it — form buttons, list rows, the whiteboard
 * canvas. It now lives in the shell's own layout: a card in the desktop
 * sidebar, a strip in the flow on smaller screens. It never floats, so it can
 * never cover anything; the shell decides where it is not shown at all.
 */
export function InstallOffer({ variant }: { variant: "strip" | "card" }) {
  const prompt = useSyncExternalStore(subscribe, getPrompt, () => null);
  const isDismissed = useSyncExternalStore(subscribe, getDismissed, () => false);
  // Client-only facts, read after mount so the server render (no offer) and the
  // first client render agree.
  const [platform, setPlatform] = useState({ ready: false, iosHelp: false, standalone: false });

  useEffect(() => {
    if (readDismissed() && !dismissed) {
      dismissed = true;
      emit();
    }
    setPlatform({
      ready: true,
      iosHelp: installsViaShareSheet(getPlatformEnvironment()),
      standalone: isStandaloneDisplayMode(),
    });
  }, []);

  if (!platform.ready || platform.standalone || isDismissed) return null;
  if (!prompt && !platform.iosHelp) return null;

  const install = prompt ? (
    <Button
      size="sm"
      onClick={() => {
        void prompt.prompt()
          .then(() => prompt.userChoice)
          .then(() => {
            capturedPrompt = null;
            emit();
          })
          .catch(() => {
            // Leave the affordance available after a transient browser error.
          });
      }}
    >
      Install
    </Button>
  ) : null;

  const close = (
    <Button variant="ghost" size="iconSm" aria-label="Dismiss" onClick={dismiss} sx={styles.close}>
      <X size={16} />
    </Button>
  );

  const message = prompt ? "Install the Orb Meet app" : "Add Orb Meet to your Home Screen";
  const hint = prompt ? "Opens in its own window." : "Tap Share, then Add to Home Screen.";

  // Not a live region: an offer the user did not ask for should not interrupt a
  // screen reader mid-sentence. It is a labelled aside they can reach on their
  // own terms.
  if (variant === "card") {
    return (
      <aside aria-label="Install Orb Meet" {...stylex.props(styles.root, styles.card)}>
        <Download size={16} aria-hidden {...stylex.props(styles.glyph)} />
        {prompt ? (
          <Button
            variant="ghost"
            size="sm"
            sx={styles.rowAction}
            onClick={() => {
              void prompt.prompt()
                .then(() => prompt.userChoice)
                .then(() => {
                  capturedPrompt = null;
                  emit();
                })
                .catch(() => {
                  // Leave the affordance available after a transient browser error.
                });
            }}
          >
            Install the app
          </Button>
        ) : (
          <p {...stylex.props(styles.rowHint)}>{hint}</p>
        )}
        {close}
      </aside>
    );
  }

  return (
    <aside aria-label="Install Orb Meet" {...stylex.props(styles.root, styles.strip)}>
      <Download size={16} aria-hidden {...stylex.props(styles.glyph)} />
      <div {...stylex.props(styles.message)}>
        <p {...stylex.props(styles.title)}>{message}</p>
        <p {...stylex.props(styles.hint)}>{hint}</p>
      </div>
      <div {...stylex.props(styles.actions)}>
        {install}
        {close}
      </div>
    </aside>
  );
}

/** Test seam: reset module state between cases. */
export function resetInstallOfferForTests() {
  capturedPrompt = null;
  dismissed = false;
  emit();
}

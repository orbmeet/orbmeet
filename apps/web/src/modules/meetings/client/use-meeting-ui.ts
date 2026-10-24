import * as React from "react";

// Chat notification sound configuration
const CHAT_NOTIFICATION_VOLUME = 0.18;
const CHAT_NOTIFICATION_MIN_INTERVAL_MS = 300;
const CHAT_NOTIFICATION_SOUND_SRC = "/sounds/chat-notification.m4a";

export function getRemoteMessageDelta(previous: number, current: number): number {
  return current >= previous ? current - previous : 0;
}

interface MeetingUIOptions {
  remoteChatMessageCount: number;
  controlBarAutoHide: boolean;
  canModerate: boolean;
  isHandRaised: boolean;
  raiseHand: () => void;
  lowerHand: () => void;
}

/**
 * The one side panel the room shows at a time.
 *
 * `timeline` is the meeting's running record — chat, speech when captions are
 * on, and raised hands — in one column, so "what happened here" is never split
 * across three panels that each hide the other two. `people` is who is here and
 * what they may do.
 */
export type MeetingSidePanel = "timeline" | "people";

export interface MeetingUIState {
  panel: MeetingSidePanel | null;
  openPanel: (panel: MeetingSidePanel) => void;
  togglePanel: (panel: MeetingSidePanel) => void;
  closePanel: () => void;
  /** Chat messages that arrived while the timeline was closed. */
  timelineUnreadCount: number;
  controlsVisible: boolean;
  /** A moderator's hand opens the timeline, where raised hands wait; anyone else's raises or lowers theirs. */
  handleHandRaiseAction: () => void;
}

export function useMeetingUI(opts: MeetingUIOptions): MeetingUIState {
  const {
    remoteChatMessageCount,
    controlBarAutoHide,
    canModerate,
    isHandRaised,
    raiseHand,
    lowerHand,
  } = opts;
  const [panel, setPanel] = React.useState<MeetingSidePanel | null>(null);
  const [timelineUnreadCount, setTimelineUnreadCount] = React.useState(0);
  const [controlsVisible, setControlsVisible] = React.useState(true);
  const hideTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousRemoteMessageCountRef = React.useRef(0);
  const chatNotificationAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const lastChatSoundAtRef = React.useRef(0);
  const timelineOpen = panel === "timeline";

  // Auto-hide controls on phone landscape
  React.useEffect(() => {
    if (!controlBarAutoHide) {
      setControlsVisible(true);
      return;
    }
    if (panel !== null) {
      setControlsVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      return;
    }
    const resetTimer = () => {
      setControlsVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
    };
    resetTimer();
    const listenerOptions: AddEventListenerOptions = { passive: true };
    window.addEventListener("pointerdown", resetTimer, listenerOptions);
    window.addEventListener("pointermove", resetTimer, listenerOptions);
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      window.removeEventListener("pointerdown", resetTimer);
      window.removeEventListener("pointermove", resetTimer);
    };
  }, [controlBarAutoHide, panel]);

  const playChatNotificationSound = React.useCallback(() => {
    if (typeof window === "undefined") return;
    const now = Date.now();
    if (now - lastChatSoundAtRef.current < CHAT_NOTIFICATION_MIN_INTERVAL_MS) return;
    lastChatSoundAtRef.current = now;
    if (!chatNotificationAudioRef.current) {
      const audio = new Audio(CHAT_NOTIFICATION_SOUND_SRC);
      audio.preload = "auto";
      audio.volume = CHAT_NOTIFICATION_VOLUME;
      chatNotificationAudioRef.current = audio;
    }
    const audio = chatNotificationAudioRef.current;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }, []);

  // The chat history is bounded, so array length is not an event counter. The
  // chat hook supplies a monotonic count that continues across history eviction.
  React.useEffect(() => {
    const previous = previousRemoteMessageCountRef.current;
    if (remoteChatMessageCount < previous) {
      previousRemoteMessageCountRef.current = remoteChatMessageCount;
      return;
    }
    const received = getRemoteMessageDelta(previous, remoteChatMessageCount);
    if (!timelineOpen && received > 0) {
      setTimelineUnreadCount((count) => count + received);
      playChatNotificationSound();
    }
    previousRemoteMessageCountRef.current = remoteChatMessageCount;
  }, [remoteChatMessageCount, timelineOpen, playChatNotificationSound]);

  // Cleanup audio element on unmount
  React.useEffect(() => {
    return () => {
      if (chatNotificationAudioRef.current) {
        chatNotificationAudioRef.current.pause();
        chatNotificationAudioRef.current.src = "";
        chatNotificationAudioRef.current = null;
      }
    };
  }, []);

  const openPanel = React.useCallback((next: MeetingSidePanel) => {
    setPanel(next);
    if (next === "timeline") setTimelineUnreadCount(0);
  }, []);
  const closePanel = React.useCallback(() => setPanel(null), []);
  const togglePanel = React.useCallback(
    (next: MeetingSidePanel) => {
      if (panel === next) setPanel(null);
      else openPanel(next);
    },
    [openPanel, panel],
  );

  const handleHandRaiseAction = React.useCallback(() => {
    if (canModerate) {
      togglePanel("timeline");
      return;
    }
    if (isHandRaised) {
      lowerHand();
    } else {
      raiseHand();
    }
  }, [canModerate, isHandRaised, lowerHand, raiseHand, togglePanel]);

  // Keyboard shortcuts
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      if (isTyping) return;
      // The board has its own keys: Escape deselects, H is the hand tool. A
      // press meant for it must not also close the panel or raise a hand.
      if (target?.closest(".tl-container")) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key === "escape") {
        if (panel !== null) setPanel(null);
        return;
      }
      if (key === "c") {
        event.preventDefault();
        togglePanel("timeline");
      }
      if (key === "h") {
        event.preventDefault();
        handleHandRaiseAction();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [panel, togglePanel, handleHandRaiseAction]);

  return {
    panel,
    openPanel,
    togglePanel,
    closePanel,
    timelineUnreadCount,
    controlsVisible,
    handleHandRaiseAction,
  };
}

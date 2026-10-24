import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type { Room } from "livekit-client";
import { logError } from "@/lib/logger";
import { clientMeetingHintsQueryOptions } from "@/app/query-client/queries/client-meeting-hints";
import { updateCaptionLanguage } from "@/modules/meetings/server/room/caption-language.functions";
import {
  loadCaptionsShown,
  normalizeSpeechLanguageTag,
  saveCaptionsShown,
  saveSpokenLanguage,
  speechLanguageDisplayName,
  SPEECH_LANGUAGE_OPTIONS,
} from "./languages";
import { useLiveTranscriptions } from "./use-live-transcriptions";

/**
 * Meeting captions are rendered from server-generated Deepgram transcripts.
 * The browser only controls local visibility and the participant's spoken
 * language preference; it never captures a second microphone stream.
 *
 * What is said is always transcribed. Each viewer chooses two things about
 * it, neither of which stops the transcript:
 *
 * - `showSpeech`: whether it is written into their Conversation. Starts on,
 *   since it is out of the way until the Conversation is opened.
 * - `showCaptions`: whether the latest line is laid over the stage, the board
 *   or a phone's card — captions, the CC button. Starts off, since that one
 *   is in everyone's face, and is remembered for the next meeting.
 */
export function useMeetingCaptions({
  roomInstance,
  meetingId,
  connectionId,
  initialCaptionLanguage,
  onCaptionLanguageConfirmed,
}: {
  roomInstance: Room | undefined;
  meetingId: string;
  connectionId: string;
  initialCaptionLanguage: string;
  /** The language the server stored, which the next join must ask for again. */
  onCaptionLanguageConfirmed?: (language: string) => void;
}) {
  const [showSpeech, setShowSpeech] = React.useState(true);
  const [showCaptions, setShowCaptions] = React.useState(loadCaptionsShown);
  const [showCaptionLanguagePicker, setShowCaptionLanguagePicker] = React.useState(false);
  const meetingHintsQuery = useQuery(clientMeetingHintsQueryOptions());
  const captionCountry = meetingHintsQuery.data?.country ?? null;
  const [captionLanguage, setCaptionLanguageState] = React.useState(
    () => normalizeSpeechLanguageTag(initialCaptionLanguage) ?? "en-US",
  );
  const captionLanguageRef = React.useRef(captionLanguage);
  const confirmedLanguageRef = React.useRef(captionLanguage);
  const languageUpdateChainRef = React.useRef<Promise<void>>(Promise.resolve());
  const captions = useLiveTranscriptions({ room: roomInstance });

  React.useEffect(() => {
    saveSpokenLanguage(captionLanguage);
  }, [captionLanguage]);
  React.useEffect(() => {
    saveCaptionsShown(showCaptions);
  }, [showCaptions]);

  const setCaptionLanguage = React.useCallback((language: string) => {
    const normalized = normalizeSpeechLanguageTag(language);
    if (!normalized || normalized === captionLanguageRef.current) return;
    captionLanguageRef.current = normalized;
    setCaptionLanguageState(normalized);

    // Preserve click order all the way to LiveKit. Independent optimistic
    // requests can otherwise complete in reverse and leave the agent using a
    // different language than the picker displays.
    languageUpdateChainRef.current = languageUpdateChainRef.current.then(async () => {
      try {
        const result = await updateCaptionLanguage({
          data: { meetingId, connectionId, language: normalized },
        });
        confirmedLanguageRef.current = result.language;
        onCaptionLanguageConfirmed?.(result.language);
      } catch (error) {
        logError("[captions] Failed to update spoken language:", error);
        if (captionLanguageRef.current === normalized) {
          captionLanguageRef.current = confirmedLanguageRef.current;
          setCaptionLanguageState(confirmedLanguageRef.current);
        }
      }
    });
  }, [connectionId, meetingId, onCaptionLanguageConfirmed]);

  const captionLanguageLabel = React.useMemo(() => {
    const option = SPEECH_LANGUAGE_OPTIONS.find((entry) => entry.tag === captionLanguage);
    return option ? speechLanguageDisplayName(option) : captionLanguage;
  }, [captionLanguage]);

  return {
    showSpeech,
    showCaptionLanguagePicker,
    setShowCaptionLanguagePicker,
    captionLanguage,
    setCaptionLanguage,
    captionLanguageLabel,
    captionCountry,
    captions,
    toggleSpeech: () => setShowSpeech((shown) => !shown),
    showCaptions,
    toggleCaptions: () => setShowCaptions((shown) => !shown),
  };
}

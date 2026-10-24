import * as React from "react";
import type { LocalVideoTrack } from "livekit-client";
import { logError } from "@/lib/logger";
import { MediaOperationQueue } from "./media-resource-controller";
import {
  type BackgroundMode,
  applyBackgroundToTrack,
  describeProcessorError,
  destroyBackgroundProcessor,
  loadBackgroundPreference,
  saveBackgroundPreference,
} from "@/modules/meetings/client/use-background-effect";

export interface PreJoinBackground {
  bgMode: BackgroundMode;
  bgImagePath: string | null;
  bgProcessing: boolean;
  bgError: string | null;
  showBgPicker: boolean;
  /** Callback ref for the picker's container; a click outside it closes the picker. */
  bgPicker: (element: HTMLDivElement | null) => void;
  onBgPickerToggle: () => void;
  onBgNone: () => void;
  onBgBlur: () => void;
  onBgImage: (path: string) => void;
  /** Apply the chosen background to a preview track that just opened. */
  applyToPreview: (track: LocalVideoTrack, isCurrent: () => boolean) => Promise<void>;
  /** Release the processor on a preview track that is closing. */
  releasePreview: (track: LocalVideoTrack | null) => Promise<void>;
}

/**
 * Blur or a virtual background on the pre-join camera preview.
 *
 * The in-meeting `useBackgroundEffect` works on the room's published track;
 * this one works on the preview track, which reopens whenever the camera or
 * its device changes. Processor work runs one operation at a time, and a
 * later choice supersedes an earlier one still applying.
 *
 * The background starts off on every visit; only the chosen image is
 * remembered, so the picker offers it again.
 */
export function usePreJoinBackground(
  previewTrackRef: React.RefObject<LocalVideoTrack | null>,
): PreJoinBackground {
  const processorRef = React.useRef<import("@livekit/track-processors").BackgroundProcessorWrapper | null>(null);
  // The preview track the processor is attached to, so a closing track only
  // tears down its own processor.
  const processorTrackRef = React.useRef<LocalVideoTrack | null>(null);
  const initialImagePath = React.useMemo(() => loadBackgroundPreference().imagePath, []);
  const [bgMode, setBgModeState] = React.useState<BackgroundMode>("none");
  const [bgImagePath, setBgImagePathState] = React.useState<string | null>(initialImagePath);
  const [bgProcessing, setBgProcessing] = React.useState(false);
  const [bgError, setBgError] = React.useState<string | null>(null);
  const [showBgPicker, setShowBgPicker] = React.useState(false);
  const [bgPickerElement, setBgPickerElement] = React.useState<HTMLDivElement | null>(null);
  const modeRef = React.useRef<BackgroundMode>("none");
  const imagePathRef = React.useRef<string | null>(initialImagePath);
  const applyIdRef = React.useRef(0);
  const operations = React.useMemo(() => new MediaOperationQueue(), []);

  const setBgMode = React.useCallback((mode: BackgroundMode) => {
    modeRef.current = mode;
    setBgModeState(mode);
  }, []);

  const setBgImagePath = React.useCallback((path: string | null) => {
    imagePathRef.current = path;
    setBgImagePathState(path);
  }, []);

  React.useEffect(() => {
    if (!showBgPicker) return;
    const handleClick = (e: MouseEvent) => {
      if (bgPickerElement && !bgPickerElement.contains(e.target as Node)) {
        setShowBgPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showBgPicker, bgPickerElement]);

  const choose = React.useCallback(async (newMode: BackgroundMode, newImage: string | null) => {
    setShowBgPicker(false);
    const track = previewTrackRef.current;
    const callId = ++applyIdRef.current;
    const prevMode = modeRef.current;
    const prevImage = imagePathRef.current;

    setBgMode(newMode);
    setBgImagePath(newImage);
    saveBackgroundPreference(newMode, newImage);
    setBgError(null);

    if (!track) return;
    setBgProcessing(true);
    try {
      await operations.run(async () => {
        processorTrackRef.current = track;
        await applyBackgroundToTrack(track, newMode, newImage, processorRef);
      });
      if (callId !== applyIdRef.current) return;
      if (newMode === "none") processorTrackRef.current = null;
    } catch (err) {
      if (callId !== applyIdRef.current) return;
      logError("Failed to apply background effect:", err);
      setBgError(describeProcessorError(err));
      setBgMode(prevMode);
      setBgImagePath(prevImage);
      processorTrackRef.current = prevMode === "none" ? null : track;
      saveBackgroundPreference(prevMode, prevImage);
    } finally {
      if (callId === applyIdRef.current) setBgProcessing(false);
    }
  }, [operations, previewTrackRef, setBgImagePath, setBgMode]);

  const applyToPreview = React.useCallback(async (track: LocalVideoTrack, isCurrent: () => boolean) => {
    const mode = modeRef.current;
    const image = imagePathRef.current;
    if (mode === "none") return;
    const callId = ++applyIdRef.current;
    setBgProcessing(true);
    try {
      await operations.run(async () => {
        if (!isCurrent()) return;
        processorTrackRef.current = track;
        await applyBackgroundToTrack(track, mode, image, processorRef);
      });
      if (callId === applyIdRef.current) setBgError(null);
    } catch (error) {
      if (callId === applyIdRef.current) setBgError(describeProcessorError(error));
    } finally {
      if (callId === applyIdRef.current) setBgProcessing(false);
    }
  }, [operations]);

  const releasePreview = React.useCallback(
    (track: LocalVideoTrack | null) => operations.run(async () => {
      if (track && processorTrackRef.current && processorTrackRef.current !== track) return;
      const processor = processorRef.current;
      processorRef.current = null;
      processorTrackRef.current = null;
      if (track) {
        try {
          await track.stopProcessor();
        } catch {
          // Track may already be stopped or may not have a processor.
        }
      }
      await destroyBackgroundProcessor(processor);
    }),
    [operations],
  );

  return {
    bgMode,
    bgImagePath,
    bgProcessing,
    bgError,
    showBgPicker,
    bgPicker: setBgPickerElement,
    onBgPickerToggle: React.useCallback(() => setShowBgPicker((v) => !v), []),
    onBgNone: React.useCallback(() => { void choose("none", null); }, [choose]),
    onBgBlur: React.useCallback(() => { void choose("blur", null); }, [choose]),
    onBgImage: React.useCallback((path: string) => { void choose("image", path); }, [choose]),
    applyToPreview,
    releasePreview,
  };
}

import * as React from "react";
import { VideoTrack } from "@livekit/components-react";
import { isWebKit } from "@/modules/meetings/client/media-quality";

/**
 * WebKit keeps painting a <video> at its stale intrinsic size after the
 * srcObject's dimensions change (e.g. the camera track flips portrait ↔
 * landscape on device rotation), leaving the frame letterboxed inside the
 * element until something forces a fresh layer. This ref detects the
 * orientation flip via the element's `resize` event and re-attaches the
 * stream to force that repaint. No-op outside Safari/iOS.
 */
export function useRotationRepaintRef(): React.RefCallback<HTMLVideoElement> {
  return React.useCallback((el: HTMLVideoElement | null) => {
    if (!el || !isWebKit()) return;

    let lastPortrait: boolean | null = null;
    let raf = 0;

    const onResize = () => {
      const portrait = el.videoHeight > el.videoWidth;
      if (!el.videoWidth || !el.videoHeight) return;
      const flipped = lastPortrait !== null && portrait !== lastPortrait;
      lastPortrait = portrait;
      if (!flipped || !el.srcObject) return;

      const stream = el.srcObject;
      el.srcObject = null;
      raf = requestAnimationFrame(() => {
        // LiveKit may have re-attached in between; don't clobber it.
        if (el.srcObject === null) {
          el.srcObject = stream;
          el.play().catch(() => {});
        }
      });
    };

    el.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("resize", onResize);
    };
  }, []);
}

/**
 * A participant's video. Picture-in-picture is off: Safari otherwise lays a
 * large "Pop out this video" button across the middle of a tile on hover.
 */
export function MeetingVideoTrack(
  props: React.ComponentProps<typeof VideoTrack>,
) {
  const repaintRef = useRotationRepaintRef();
  return <VideoTrack ref={repaintRef} disablePictureInPicture {...props} />;
}

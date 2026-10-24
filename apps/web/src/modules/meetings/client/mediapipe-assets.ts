// Where the self-hosted MediaPipe files live. Each URL names exactly what it
// holds — the package version, or the model's content hash — so browsers, the
// CDN and the service worker can keep them for good: a new version is a new
// URL. scripts/setup-assets.mjs materializes them from these values, and loads
// this module directly, so it stays free of imports.

/** The @mediapipe/tasks-vision release whose WASM fileset is served. */
export const MEDIAPIPE_TASKS_VISION_VERSION = "0.10.14";

/** SHA-256 of the selfie segmentation model, which upstream publishes only as `latest`. */
export const SELFIE_SEGMENTER_SHA256 = "191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b";

export const MEDIAPIPE_FILESET_PATH = `/wasm/mediapipe/${MEDIAPIPE_TASKS_VISION_VERSION}`;

export const SELFIE_SEGMENTER_MODEL_PATH =
  `/wasm/models/selfie_segmenter-${SELFIE_SEGMENTER_SHA256.slice(0, 16)}.tflite`;

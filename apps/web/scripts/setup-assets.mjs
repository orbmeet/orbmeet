#!/usr/bin/env node
/**
 * Copies the browser runtime files the app serves itself into public/. Each
 * URL names exactly what it holds, so browsers, the CDN and the service worker
 * keep them for good:
 *
 *   /wasm/mediapipe/<version>/  the MediaPipe WASM fileset, from the
 *                               @mediapipe/tasks-vision that @livekit/track-processors loads
 *   /wasm/models/<name>-<hash>  the selfie segmentation model, downloaded and hash-checked
 *   /wb-assets/<version>/       @tldraw/assets: the whiteboard's fonts, icons and translations
 *
 * Anything else under those roots is a previous version and is removed, since
 * everything under public/ is deployed.
 */

import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { findPackageJSON } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  MEDIAPIPE_FILESET_PATH,
  MEDIAPIPE_TASKS_VISION_VERSION,
  SELFIE_SEGMENTER_MODEL_PATH,
  SELFIE_SEGMENTER_SHA256,
} from "../src/modules/meetings/client/mediapipe-assets.ts";

const PUBLIC = resolve(import.meta.dirname, "../public");
const SELFIE_SEGMENTER_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
/** The @tldraw/assets directories the whiteboard's asset URLs point into. */
const WHITEBOARD_ASSET_DIRS = ["fonts", "icons/icon/0_merged.svg", "embed-icons", "translations"];

/**
 * A package's real directory (not pnpm's symlink, so its own dependencies
 * resolve from it), as `from` resolves it, whatever its `exports` allow.
 */
function packageDir(specifier, from = import.meta.url) {
  const manifest = findPackageJSON(specifier, from);
  if (!manifest) throw new Error(`Cannot resolve ${specifier}; run pnpm install`);
  return { dir: dirname(realpathSync(manifest)), version: JSON.parse(readFileSync(manifest, "utf8")).version };
}

/** Copy `source` (a file or directory) to `destination`, skipping files already there. */
function mirror(source, destination) {
  if (statSync(source).isDirectory()) {
    for (const entry of readdirSync(source)) mirror(join(source, entry), join(destination, entry));
    return;
  }
  // A versioned directory never changes content, so a present file of the
  // same size is the same file.
  if (existsSync(destination) && statSync(destination).size === statSync(source).size) return;
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

/** Remove everything under `root` but the paths in `keep` (and their parents). */
function prune(root, keep) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (keep.some((kept) => kept === path)) continue;
    if (entry.isDirectory() && keep.some((kept) => kept.startsWith(`${path}/`))) {
      prune(path, keep);
      continue;
    }
    rmSync(path, { recursive: true, force: true });
    console.log(`[assets] Removed stale ${relative(PUBLIC, path)}`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function download(url, destination, expectedSha256) {
  if (existsSync(destination) && sha256(destination) === expectedSha256) return;
  console.log(`[assets] Downloading ${url}`);
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
    const actual = sha256(temporary);
    if (actual !== expectedSha256) {
      throw new Error(`Checksum mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function prepareMediaPipe() {
  const trackProcessors = packageDir("@livekit/track-processors");
  const mediapipe = packageDir("@mediapipe/tasks-vision", join(trackProcessors.dir, "package.json"));
  if (mediapipe.version !== MEDIAPIPE_TASKS_VISION_VERSION) {
    throw new Error(
      `@livekit/track-processors loads @mediapipe/tasks-vision ${mediapipe.version}, but ` +
        `MEDIAPIPE_TASKS_VISION_VERSION is ${MEDIAPIPE_TASKS_VISION_VERSION}; update src/modules/meetings/client/mediapipe-assets.ts`,
    );
  }
  const fileset = join(PUBLIC, MEDIAPIPE_FILESET_PATH);
  const model = join(PUBLIC, SELFIE_SEGMENTER_MODEL_PATH);
  mirror(join(mediapipe.dir, "wasm"), fileset);
  await download(SELFIE_SEGMENTER_URL, model, SELFIE_SEGMENTER_SHA256);
  prune(join(PUBLIC, "wasm"), [fileset, model]);
}

function prepareWhiteboardAssets() {
  // The copy the whiteboard client builds its asset URLs from.
  const whiteboardClient = new URL("../../../packages/whiteboard-client/package.json", import.meta.url);
  const assets = packageDir("@tldraw/assets", whiteboardClient);
  const destination = join(PUBLIC, "wb-assets", assets.version);
  for (const path of WHITEBOARD_ASSET_DIRS) mirror(join(assets.dir, path), join(destination, path));
  prune(join(PUBLIC, "wb-assets"), [destination]);
}

await prepareMediaPipe();
prepareWhiteboardAssets();
console.log("[assets] Runtime assets ready");

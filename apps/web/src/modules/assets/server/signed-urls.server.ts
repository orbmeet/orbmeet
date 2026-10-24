import "@tanstack/react-start/server-only";
import { buildAttachmentContentDisposition } from "./content-disposition";
import { buildR2Client } from "./r2-client.server";

/**
 * How long a signed R2 URL stays usable.
 *
 * A signed URL cannot be recalled: revoking someone's access in D1 does not
 * retract a link they already hold, so the window is how long revocation takes
 * to take effect. A download starts as soon as the browser gets the link, so it
 * needs minutes, not an hour. Playback is different — a `<video>` element
 * re-issues range requests as the viewer seeks, for as long as the recording
 * runs — so it keeps the longer window rather than breaking halfway through a
 * meeting recording.
 */
const SIGNED_DOWNLOAD_URL_TTL_SECONDS = 300;

const SIGNED_PLAYBACK_URL_TTL_SECONDS = 3600;

/** A short-lived URL that downloads the object as an attachment. */
export async function signDownloadUrl(env: Env, object: { r2Key: string; filename: string | null }) {
  const { r2, endpoint } = buildR2Client(env);
  const url = new URL(`/${env.R2_BUCKET_NAME}/${object.r2Key}`, endpoint);
  url.searchParams.set("X-Amz-Expires", String(SIGNED_DOWNLOAD_URL_TTL_SECONDS));
  url.searchParams.set(
    "response-content-disposition",
    buildAttachmentContentDisposition(object.filename ?? "download"),
  );
  url.searchParams.set(
    "response-cache-control",
    `private, max-age=${SIGNED_DOWNLOAD_URL_TTL_SECONDS}`,
  );

  const signed = await r2.sign(new Request(url.toString()), {
    aws: { signQuery: true },
  });
  return { url: signed.url };
}

/** A URL a <video> element can stream: no attachment disposition, so the browser plays it. */
export async function signPlaybackUrl(env: Env, r2Key: string) {
  const { r2, endpoint } = buildR2Client(env);
  const url = new URL(`/${env.R2_BUCKET_NAME}/${r2Key}`, endpoint);
  url.searchParams.set("X-Amz-Expires", String(SIGNED_PLAYBACK_URL_TTL_SECONDS));
  url.searchParams.set(
    "response-cache-control",
    `private, max-age=${SIGNED_PLAYBACK_URL_TTL_SECONDS}`,
  );

  const signed = await r2.sign(new Request(url.toString()), {
    aws: { signQuery: true },
  });
  return { url: signed.url };
}

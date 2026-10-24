import "@tanstack/react-start/server-only";

import { AwsClient } from "aws4fetch";

// aws4fetch deliberately excludes Content-Type and Content-Length unless
// allHeaders is enabled. Upload URLs must bind both so a bearer URL cannot be
// replayed with a larger or differently typed object after finalization.
export const PRESIGNED_R2_UPLOAD_SIGN_OPTIONS = {
  aws: { signQuery: true, allHeaders: true },
} as const;

export function buildR2Client(env: Env) {
  return {
    r2: new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    }),
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  };
}

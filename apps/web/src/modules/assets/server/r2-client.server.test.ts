import { describe, expect, it } from "vitest";

import { buildPresignedUploadHeaders } from "@/modules/assets/server/upload-headers";
import {
  buildR2Client,
  PRESIGNED_R2_UPLOAD_SIGN_OPTIONS,
} from "./r2-client.server";

describe("presigned R2 upload signing", () => {
  it("binds the authorized content length and type into the signature", async () => {
    const env = {
      R2_ACCESS_KEY_ID: "test-access-key",
      R2_SECRET_ACCESS_KEY: "test-secret-key",
      R2_ACCOUNT_ID: "00000000000000000000000000000000",
    } as Env;
    const { r2, endpoint } = buildR2Client(env);
    const headers = buildPresignedUploadHeaders({
      mimeType: "image/png",
      fileSize: 123,
    });
    const signed = await r2.sign(new Request(`${endpoint}/bucket/image.png`, {
      method: "PUT",
      headers,
    }), PRESIGNED_R2_UPLOAD_SIGN_OPTIONS);

    expect(new URL(signed.url).searchParams.get("X-Amz-SignedHeaders"))
      .toBe("content-length;content-type;host");
  });
});

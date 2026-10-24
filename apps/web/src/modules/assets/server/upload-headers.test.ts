import { describe, expect, it } from "vitest";

import { buildPresignedUploadHeaders } from "./upload-headers";

describe("buildPresignedUploadHeaders", () => {
  it("binds presigned uploads to the expected byte length", () => {
    expect(
      buildPresignedUploadHeaders({
        mimeType: "image/png",
        fileSize: 1234,
      }),
    ).toMatchObject({
      "Content-Type": "image/png",
      "Content-Length": "1234",
    });
  });

  it("preserves optional md5 validation", () => {
    expect(
      buildPresignedUploadHeaders({
        mimeType: "image/png",
        fileSize: 1,
        md5Hash: "d41d8cd98f00b204e9800998ecf8427e",
      })["Content-MD5"],
    ).toBe("1B2M2Y8AsgTpgAmY7PhCfg==");
  });

  it("rejects malformed md5 input before generating upload headers", () => {
    expect(() => buildPresignedUploadHeaders({
      mimeType: "image/png",
      fileSize: 1,
      md5Hash: "not-a-valid-md5",
    })).toThrow(/32-character hexadecimal/i);
  });
});

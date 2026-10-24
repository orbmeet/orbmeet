import { Errors } from "@/lib/app-errors";

/** Promote exactly one staging generation. Final keys are never overwritten or
 * compensated by a request: an ambiguous database commit must remain recoverable.
 * Staging keys expire independently and are never exposed by asset readers.
 */
export async function promoteImmutableUpload(
  bucket: R2Bucket,
  input: {
    stagingKey: string;
    finalKey: string;
    mimeType: string;
    owner: string;
    expectedSize?: number;
    maxSize: number;
    signature?: readonly number[];
    headerValidation?: {
      length: number;
      validate: (bytes: Uint8Array) => boolean;
    };
    /**
     * Runs after the exact source generation has been inspected and before it
     * is copied. Callers use this to commit quota/reservation state against
     * R2's authoritative object size. It must be idempotent because a retry
     * may find an already-promoted final object.
     */
    beforePromote?: (object: R2Object) => void | Promise<void>;
  },
): Promise<R2Object> {
  const validateFinal = (object: R2Object | null): R2Object => {
    if (!object || object.customMetadata?.uploadOwner !== input.owner) {
      throw Errors.CONFLICT("Upload finalization belongs to another request");
    }
    if (object.size > input.maxSize ||
      (input.expectedSize !== undefined && object.size !== input.expectedSize)) {
      throw Errors.VALIDATION("Upload size does not match its reservation");
    }
    return object;
  };
  const existing = await bucket.head(input.finalKey);
  if (existing) {
    const validated = validateFinal(existing);
    await input.beforePromote?.(validated);
    return validated;
  }

  const header = await bucket.get(input.stagingKey, {
    range: {
      offset: 0,
      length: input.headerValidation?.length ?? input.signature?.length ?? 1,
    },
  });
  if (!header) throw Errors.NOT_FOUND("Uploaded file");
  if (header.size > input.maxSize ||
    (input.expectedSize !== undefined && header.size !== input.expectedSize)) {
    throw Errors.VALIDATION("Upload size does not match its reservation");
  }
  const bytes = new Uint8Array(await header.arrayBuffer());
  if (input.signature && (bytes.length !== input.signature.length ||
    !input.signature.every((byte, index) => bytes[index] === byte))) {
    throw Errors.VALIDATION("Uploaded file has an invalid signature");
  }
  if (input.headerValidation && !input.headerValidation.validate(bytes)) {
    throw Errors.VALIDATION("Uploaded file has an invalid signature");
  }
  await input.beforePromote?.(header);
  const source = await bucket.get(input.stagingKey, { onlyIf: { etagMatches: header.etag } });
  if (!source || !("body" in source)) {
    throw Errors.CONFLICT("Uploaded file changed; retry finalization");
  }
  const created = await bucket.put(input.finalKey, source.body, {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    httpMetadata: { contentType: input.mimeType },
    customMetadata: { uploadOwner: input.owner, sourceEtag: header.etag },
  });
  return validateFinal(created ?? await bucket.head(input.finalKey));
}

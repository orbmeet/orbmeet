import { describe, expect, it, vi } from "vitest";
import { promoteImmutableUpload } from "./immutable-upload";

function storage() {
  type Stored = { bytes: Uint8Array; etag: string; customMetadata?: Record<string, string> };
  const objects = new Map<string, Stored>();
  let generation = 0;
  const write = (key: string, text: string) => {
    objects.set(key, { bytes: new TextEncoder().encode(text), etag: String(++generation) });
  };
  const describe = (key: string, object: Stored) => ({
    key, size: object.bytes.length, etag: object.etag, customMetadata: object.customMetadata,
  });
  const bucket = {
    head: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object ? describe(key, object) : null;
    }),
    get: vi.fn(async (key: string, options?: R2GetOptions) => {
      const object = objects.get(key);
      if (!object) return null;
      const onlyIf = options?.onlyIf as R2Conditional | undefined;
      if (onlyIf?.etagMatches && onlyIf.etagMatches !== object.etag) return describe(key, object);
      const range = options?.range as { length?: number } | undefined;
      const bytes = object.bytes.slice(0, range?.length);
      return { ...describe(key, object), body: new Response(bytes).body,
        arrayBuffer: async () => bytes.buffer };
    }),
    put: vi.fn(async (key: string, value: ReadableStream, options: R2PutOptions) => {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      expect((options.onlyIf as Headers).get("If-None-Match")).toBe("*");
      if (objects.has(key)) return null;
      const object = { bytes, etag: String(++generation), customMetadata: options.customMetadata };
      objects.set(key, object);
      return describe(key, object);
    }),
    delete: vi.fn(),
  };
  return { bucket: bucket as unknown as R2Bucket, mocks: bucket, objects, write };
}
const input = { stagingKey: "staging/pdf", finalKey: "final.pdf", owner: "user",
  mimeType: "application/pdf", expectedSize: 6, maxSize: 100, signature: [37, 80, 68, 70, 45] };

describe("immutable upload promotion", () => {
  it("concurrent finalizers and staging replay retain the first committed generation", async () => {
    const store = storage();
    store.write(input.stagingKey, "%PDF-A");
    const results = await Promise.all([promoteImmutableUpload(store.bucket, input), promoteImmutableUpload(store.bucket, input)]);
    expect(results[0].etag).toBe(results[1].etag);
    store.write(input.stagingKey, "%PDF-B");
    expect((await promoteImmutableUpload(store.bucket, input)).etag).toBe(results[0].etag);
    expect(new TextDecoder().decode(store.objects.get(input.finalKey)!.bytes)).toBe("%PDF-A");
    expect(store.mocks.delete).not.toHaveBeenCalled();
  });

  it("rejects a same-size staging replacement between inspection and copying", async () => {
    const store = storage();
    store.write(input.stagingKey, "%PDF-A");
    const get = store.mocks.get.getMockImplementation()!;
    store.mocks.get.mockImplementation(async (key, options) => {
      if (options?.onlyIf) store.write(key, "BADPDF");
      return get(key, options);
    });
    await expect(promoteImmutableUpload(store.bucket, input)).rejects.toThrow("changed");
    expect(store.mocks.put).not.toHaveBeenCalled();
  });

  it("runs the commit hook before copying and ETag-fences mutations made by it", async () => {
    const store = storage();
    store.write(input.stagingKey, "%PDF-A");
    const beforePromote = vi.fn(async () => {
      store.write(input.stagingKey, "%PDF-B");
    });

    await expect(promoteImmutableUpload(store.bucket, { ...input, beforePromote }))
      .rejects.toThrow("changed");
    expect(beforePromote).toHaveBeenCalledTimes(1);
    expect(store.mocks.put).not.toHaveBeenCalled();
  });

  it("retains an immutable object for retry after metadata finalization fails", async () => {
    const store = storage();
    store.write(input.stagingKey, "%PDF-A");
    const object = await promoteImmutableUpload(store.bucket, input);
    store.objects.delete(input.stagingKey);
    expect((await promoteImmutableUpload(store.bucket, input)).etag).toBe(object.etag);
    await expect(promoteImmutableUpload(store.bucket, { ...input, owner: "other" })).rejects.toThrow("another request");
    expect(store.mocks.delete).not.toHaveBeenCalled();
  });

  it("rejects a staging object that fails its format-specific header validator", async () => {
    const store = storage();
    store.write(input.stagingKey, "<html>");
    await expect(promoteImmutableUpload(store.bucket, {
      ...input,
      signature: undefined,
      headerValidation: {
        length: 6,
        validate: (bytes) => new TextDecoder().decode(bytes).startsWith("GIF89a"),
      },
    })).rejects.toThrow("invalid signature");
    expect(store.mocks.put).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { isSafeExternalBrowserUrl } from "@orbmeet/whiteboard-core/public-host";

/**
 * The client and the sync server have to agree about which URLs may appear on a
 * synced record. They do not merely have to agree in spirit: the server's
 * refusal is a FORBIDDEN session close, after which the socket adapter stops
 * reconnecting, so a URL the client accepts and the server rejects costs the
 * participant their sync session rather than costing them one edit.
 *
 * Both sides answer the question with the same predicate from
 * `@orbmeet/whiteboard-core/public-host`. What can drift is *where* the client
 * asks: a check placed after tldraw has already built the shape is too late to
 * decline it, which is how bookmark shapes for `mailto:` and private-host links
 * reached the server in the first place.
 */
describe("external URL content policy", () => {
  it("refuses URLs the sync server's record guard would reject", () => {
    for (const url of [
      "mailto:someone@example.com",
      "javascript:alert(1)",
      "http://localhost:8787/room",
      "http://127.0.0.1/",
      "http://192.168.1.10/internal",
      "http://169.254.169.254/latest/meta-data/",
      "http://board.internal/",
    ]) {
      expect(`${url} -> ${isSafeExternalBrowserUrl(url)}`).toBe(`${url} -> false`);
    }
  });

  it("still admits ordinary public links", () => {
    for (const url of ["https://example.com/page", "http://example.com/page"]) {
      expect(`${url} -> ${isSafeExternalBrowserUrl(url)}`).toBe(`${url} -> true`);
    }
  });

  it("checks the URL before tldraw is allowed to build anything from it", async () => {
    const source = await readFile(
      new URL("./use-whiteboard-image-import.ts", import.meta.url),
      "utf8",
    );
    const guard = source.indexOf("if (!isSafeExternalBrowserUrl(externalContent.url))");
    const defaultHandler = source.indexOf("await defaultHandleExternalUrlContent(");
    const imageImport = source.indexOf("await importExternalImageUrl(");

    // The url content handler must apply the shared host policy, and must do so
    // before either path that turns the URL into a record.
    expect(guard).toBeGreaterThan(-1);
    expect(defaultHandler).toBeGreaterThan(guard);
    expect(imageImport).toBeGreaterThan(guard);
  });
});

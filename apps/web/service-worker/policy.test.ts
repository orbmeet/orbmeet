import { describe, expect, it } from "vitest";
import { canonicalDocumentPath, isCacheableDocument, isImmutableAsset, isServerPath } from "./policy";

describe("service worker policy", () => {
  it("leaves server routes and server functions to the network", () => {
    expect(isServerPath("/api/auth/callback/google")).toBe(true);
    expect(isServerPath("/_serverFn/abc")).toBe(true);
    expect(isServerPath("/apiary")).toBe(false);
  });

  it("caches for good only URLs that name their content", () => {
    expect(isImmutableAsset("/assets/index-Cw4KJozZ.css")).toBe(true);
    expect(isImmutableAsset("/wasm/mediapipe/0.10.14/vision_wasm_internal.wasm")).toBe(true);
    expect(isImmutableAsset("/wb-assets/5.5.0/fonts/IBMPlexSans-Medium.woff2")).toBe(true);
    expect(isImmutableAsset("/fonts/inter-400.woff2")).toBe(false);
    expect(isImmutableAsset("/manifest.json")).toBe(false);
  });

  it("keeps public pages offline, but nothing private or failed", () => {
    const publicDocuments = ["/", "/pricing"];
    const ok = (cacheControl?: string) =>
      new Response("<html>", { status: 200, headers: cacheControl ? { "Cache-Control": cacheControl } : {} });

    expect(isCacheableDocument("/pricing/", ok(), publicDocuments)).toBe(true);
    expect(isCacheableDocument("/", ok("public, max-age=0, must-revalidate"), publicDocuments)).toBe(true);
    expect(isCacheableDocument("/pricing", ok("private, no-store"), publicDocuments)).toBe(false);
    expect(isCacheableDocument("/home", ok(), publicDocuments)).toBe(false);
    expect(isCacheableDocument("/pricing", new Response("", { status: 500 }), publicDocuments)).toBe(false);
  });

  it("keys documents by their slash-less path", () => {
    expect(canonicalDocumentPath("/pricing/")).toBe("/pricing");
    expect(canonicalDocumentPath("/")).toBe("/");
  });
});

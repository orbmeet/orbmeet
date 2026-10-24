import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "./html-entities.ts";

describe("decodeHtmlEntities", () => {
  it("decodes named, decimal, and hex entities", () => {
    expect(decodeHtmlEntities("Fish &amp; Chips")).toBe("Fish & Chips");
    expect(decodeHtmlEntities("&lt;b&gt;bold&lt;/b&gt;")).toBe("<b>bold</b>");
    expect(decodeHtmlEntities("&#65;&#x42;")).toBe("AB");
    expect(decodeHtmlEntities("Caf&eacute; &Eacute;t&eacute;")).toBe("Café Été");
  });

  it("never double-decodes escaped entities", () => {
    // "&amp;lt;" is the page author writing the literal text "&lt;" — decoding
    // it to "<" would let metadata smuggle markup past the first decode.
    expect(decodeHtmlEntities("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
    expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
    expect(decodeHtmlEntities("&amp;#60;")).toBe("&#60;");
  });

  it("drops control characters and invalid code points from numeric entities", () => {
    expect(decodeHtmlEntities("a&#0;b&#x1f;c&#x85;d")).toBe("abcd");
    expect(decodeHtmlEntities("bad&#xd800;pair")).toBe("badpair");
    expect(decodeHtmlEntities("over&#x110000;flow")).toBe("overflow");
  });

  it("leaves unknown entities and bare ampersands untouched", () => {
    expect(decodeHtmlEntities("&unknown; & &almost")).toBe("&unknown; & &almost");
  });
});

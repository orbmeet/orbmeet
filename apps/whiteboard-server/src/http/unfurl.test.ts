import { describe, expect, it } from "vitest";
import { extractMetaTags, extractTitle, isUnfurlableMediaType, resolveUnfurlRedirect } from "./unfurl.ts";

describe("resolveUnfurlRedirect", () => {
  it("allows same-security redirects and HTTP upgrades", () => {
    expect(resolveUnfurlRedirect(new URL("https://a.example/x"), "/next").href)
      .toBe("https://a.example/next");
    expect(resolveUnfurlRedirect(new URL("http://a.example/x"), "https://b.example/y").href)
      .toBe("https://b.example/y");
  });

  it("rejects HTTPS downgrade and non-web protocols", () => {
    expect(() => resolveUnfurlRedirect(new URL("https://a.example"), "http://b.example"))
      .toThrow(/downgrade/i);
    expect(() => resolveUnfurlRedirect(new URL("http://a.example"), "file:///etc/passwd"))
      .toThrow(/protocol/i);
  });
});

describe("isUnfurlableMediaType", () => {
  it("accepts the markup types, with or without parameters", () => {
    expect(isUnfurlableMediaType("text/html")).toBe(true);
    expect(isUnfurlableMediaType("text/html; charset=utf-8")).toBe(true);
    expect(isUnfurlableMediaType("  TEXT/HTML ;charset=UTF-8")).toBe(true);
    expect(isUnfurlableMediaType("text/plain")).toBe(true);
    expect(isUnfurlableMediaType("application/xhtml+xml")).toBe(true);
  });

  it("rejects a non-markup type that merely mentions one in its parameters", () => {
    // Parameters are attacker-controlled text. Matching the header as a
    // substring would send this binary body to the meta-tag extractor.
    expect(isUnfurlableMediaType("image/png; charset=utf-8; x=text/html")).toBe(false);
    expect(isUnfurlableMediaType('application/octet-stream; name="text/plain"')).toBe(false);
    expect(isUnfurlableMediaType("application/pdf;q=application/xhtml")).toBe(false);
  });

  it("rejects a type that only has a markup type as a prefix or suffix", () => {
    expect(isUnfurlableMediaType("text/htmlx")).toBe(false);
    expect(isUnfurlableMediaType("xtext/html")).toBe(false);
    expect(isUnfurlableMediaType("")).toBe(false);
  });
});

describe("extractMetaTags", () => {
  it("reads quoted, single-quoted, and unquoted attribute values", () => {
    const meta = extractMetaTags(`
      <meta property="og:title" content="Quoted title">
      <meta name='twitter:title' content='Single quoted'>
      <meta name=description content=Unquoted>
    `);
    expect(meta.get("og:title")).toBe("Quoted title");
    expect(meta.get("twitter:title")).toBe("Single quoted");
    expect(meta.get("description")).toBe("Unquoted");
  });

  it("keeps the first declaration of a key and the last value of an attribute", () => {
    const meta = extractMetaTags(`
      <meta property="og:title" content="first">
      <meta property="og:title" content="second">
      <meta property="og:image" content="a" content="b">
    `);
    expect(meta.get("og:title")).toBe("first");
    expect(meta.get("og:image")).toBe("b");
  });

  it("tolerates self-closing tags, valueless attributes, and odd spacing", () => {
    const meta = extractMetaTags(
      `<meta itemscope property = "og:title"   content="spaced" />` +
      `<meta\n\tname="description"\r\ncontent="multiline">`,
    );
    expect(meta.get("og:title")).toBe("spaced");
    expect(meta.get("description")).toBe("multiline");
  });

  it("ignores an attribute whose name is not name-shaped", () => {
    // The regex this replaced would rescan from inside the token and report a
    // `content` the page never declared.
    const meta = extractMetaTags(`<meta property="og:title" 9content="injected">`);
    expect(meta.size).toBe(0);
  });

  it("scans a pathological tag in linear time", () => {
    // A name-shaped run never followed by `=`: the quadratic scan this replaced
    // needed ~10s at 80KB and tens of minutes at the 1MB response cap, blocking
    // the event loop shared by every room on the host.
    const html = `<meta ${"a".repeat(1024 * 1024)}>`;
    const startedAt = performance.now();
    expect(extractMetaTags(html).size).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("scans a document of unterminated tag starts in linear time", () => {
    // The quadratic case the tag scanner replaced: every `<meta` with no `>`
    // after it made the regex rescan the whole remaining document. 100KB took
    // ~350ms on Bun, and the 1MiB response cap is the only other bound.
    const html = "<meta".repeat(200_000);
    const startedAt = performance.now();
    expect(extractMetaTags(html).size).toBe(0);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("does not treat a longer tag name as a meta tag", () => {
    expect(extractMetaTags(`<metadata property="og:title" content="x">`).size).toBe(0);
    expect(extractMetaTags(`<META PROPERTY="og:title" CONTENT="x">`).get("og:title")).toBe("x");
  });

  it("still extracts metadata from a tag padded with a huge valueless run", () => {
    const html = `<meta ${"a".repeat(200_000)} property="og:title" content="found">`;
    expect(extractMetaTags(html).get("og:title")).toBe("found");
  });
});

describe("extractTitle", () => {
  const regexTitle = (html: string) => html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? null;

  it("reads the first well-formed title, case-insensitively", () => {
    expect(extractTitle("<head><TITLE lang=en>Hello</Title></head>")).toBe("Hello");
    expect(extractTitle("<title>a<b></title><title>second</title>")).toBe("second");
    expect(extractTitle("<title>unterminated")).toBeNull();
    expect(extractTitle("no title here")).toBeNull();
  });

  it("agrees with the regex it replaced", () => {
    // Small alphabet, so the fragments collide often.
    const parts = ["<title", "<TITLE", ">", "<", "</title>", "</TITLE>", "x", " ", "<b>"];
    let seed = 7;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    for (let run = 0; run < 5_000; run++) {
      let html = "";
      const length = next() % 12;
      for (let i = 0; i < length; i++) html += parts[next() % parts.length];
      expect({ html, title: extractTitle(html) }).toEqual({ html, title: regexTitle(html) });
    }
  });

  it("scans unterminated title starts in linear time", () => {
    // The regex needed ~12s on Bun for 480KB of this, on the event loop every
    // room on the host shares.
    for (const html of ["<title".repeat(200_000), `${"<title".repeat(200_000)}>x`]) {
      const startedAt = performance.now();
      expect(extractTitle(html)).toBeNull();
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    }
  });
});

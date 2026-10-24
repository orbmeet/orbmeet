import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROBOTS,
  absoluteUrl,
  buildAiDiscoveryDocument,
  buildLlmsTxt,
  createPageHead,
} from "./seo";

describe("seo helpers", () => {
  it("builds canonical metadata for indexable pages", () => {
    const head = createPageHead({
      title: "Pricing — Orb Meet",
      description: "Plan details",
      path: "/pricing",
    });

    expect(head.meta).toEqual(
      expect.arrayContaining([
        { title: "Pricing — Orb Meet" },
        { name: "description", content: "Plan details" },
        { name: "robots", content: DEFAULT_ROBOTS },
        { property: "og:url", content: absoluteUrl("/pricing") },
      ]),
    );
    expect(head.links).toEqual(
      expect.arrayContaining([{ rel: "canonical", href: absoluteUrl("/pricing") }]),
    );
  });

  it("omits canonical links and marks noindex pages correctly", () => {
    const head = createPageHead({
      title: "Sign In — Orb Meet",
      description: "Auth flow",
      noindex: true,
      canonical: false,
    });

    expect(head.links).toEqual([]);
    expect(head.meta).toEqual(
      expect.arrayContaining([
        { name: "robots", content: "noindex, nofollow, noarchive" },
      ]),
    );
  });

  it("renders llms.txt with key discovery endpoints", () => {
    const content = buildLlmsTxt();

    expect(content).toContain("# Orb Meet");
    expect(content).toContain("https://orbmeet.com/llms.txt");
    expect(content).toContain("https://orbmeet.com/api/llms.json");
    expect(content).toContain("https://orbmeet.com/sitemap.xml");
  });

  it("builds a machine-readable discovery document", () => {
    const discovery = buildAiDiscoveryDocument();

    expect(discovery.site.url).toBe("https://orbmeet.com");
    expect(discovery.machineReadableEndpoints.llmsTxt).toBe("https://orbmeet.com/llms.txt");
    expect(discovery.pages.some((page) => page.url === "https://orbmeet.com/pricing")).toBe(true);
  });
});

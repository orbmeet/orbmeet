import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRESET_BACKGROUNDS } from "./use-background-effect";

const PUBLIC = join(import.meta.dirname, "../../../../public");

/**
 * The background processor turns each preset into a bitmap with
 * `createImageBitmap(img)`. An SVG with only a viewBox has no natural size:
 * Chrome refuses to make a bitmap of it ("SVG image without natural
 * dimensions"), and Firefox makes a 300×150 one, stretched blurry over the
 * video. Safari alone sizes it from the viewBox.
 */
describe("background presets", () => {
  it.each(PRESET_BACKGROUNDS)("%s has a natural size", (path) => {
    const svg = readFileSync(join(PUBLIC, path), "utf8");
    const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
    expect(root).toMatch(/\swidth="\d+"/);
    expect(root).toMatch(/\sheight="\d+"/);
  });
});

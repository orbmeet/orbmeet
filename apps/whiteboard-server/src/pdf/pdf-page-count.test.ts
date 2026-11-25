import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readPdfPageCount } from "./pdf-render.ts";

// Real mutool, where it is installed (the image always has it).
const hasMutool = spawnSync("mutool", ["-v"]).error === undefined;
const dir = mkdtempSync(join(tmpdir(), "pdf-page-count-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A minimal PDF of `pages` pages; `count` is what its page tree claims, `title` its Info title. */
function writePdf(name: string, { pages, title = "x", indirectCount = false }: { pages: number; title?: string; indirectCount?: boolean }): string {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  const countRef = 3 + pages + 1;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${indirectCount ? `${countRef} 0 R` : pages} >>`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>"),
    `<< /Title (${title}) >>`,
    ...(indirectCount ? [String(pages)] : []),
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${3 + pages} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe.skipIf(!hasMutool)("readPdfPageCount", () => {
  it("counts the page tree's pages", async () => {
    await expect(readPdfPageCount(writePdf("three.pdf", { pages: 3 }))).resolves.toBe(3);
  });

  it("is not misled by document metadata that reads like a page count", async () => {
    await expect(readPdfPageCount(writePdf("titled.pdf", { pages: 1, title: "Pages: 999" }))).resolves.toBe(1);
  });

  it("follows a count stored as an indirect object", async () => {
    await expect(readPdfPageCount(writePdf("indirect.pdf", { pages: 2, indirectCount: true }))).resolves.toBe(2);
  });

  it("answers null for a file that is not a PDF", async () => {
    const path = join(dir, "not.pdf");
    writeFileSync(path, "hello");
    await expect(readPdfPageCount(path)).resolves.toBeNull();
  });
});

/** Whiteboard vendor module paths in node_modules. */
const VENDOR_RE = /\/node_modules\/(tldraw|@tldraw[/+]|pdf-lib)/;

/** Rich-text rendering the whiteboard loads with its text surfaces. */
const SURFACE_TEXT_PACKAGES = ["@speed-highlight/", "katex/", "escape-string-regexp/"];

/** Helpers the whiteboard engine initializes eagerly; kept in one chunk. */
const SURFACE_CORE_PACKAGES = [
  "rbush/",
  "lz-string/",
  "linkifyjs/",
  "eventemitter3/",
  "@radix-ui/",
  "w3c-keyname/",
  "css-tree/",
  "bidi-js/",
  "classnames/",
  "lodash.",
];

const inPackage = (id: string, packages: readonly string[]) =>
  packages.some((name) => id.includes(`/node_modules/${name}`));

export function isWhiteboardVendor(id: string): boolean {
  return VENDOR_RE.test(id);
}

/** The named chunk a whiteboard dependency belongs in, if any. */
export function classifyWhiteboardChunk(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  if (inPackage(id, ["pdf-lib/", "@pdf-lib/"])) return "vendor-surface-document";
  if (inPackage(id, SURFACE_TEXT_PACKAGES)) return "vendor-surface-text";
  if (inPackage(id, SURFACE_CORE_PACKAGES)) return "vendor-surface-core";
  return undefined;
}

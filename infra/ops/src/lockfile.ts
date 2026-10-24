import { posix } from "node:path";
import { parseAllDocuments } from "yaml";
import { OpsError } from "./shell.ts";

type Dependencies = Record<string, { version: string }>;

interface Importer {
  dependencies?: Dependencies;
  optionalDependencies?: Dependencies;
  devDependencies?: Dependencies;
}

interface Snapshot {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface Lockfile {
  settings?: unknown;
  overrides?: unknown;
  importers: Record<string, Importer>;
  snapshots?: Record<string, Snapshot>;
}

/**
 * The part of pnpm-lock.yaml that installing these workspace directories
 * reads: their own entries, the workspace packages they link, and every
 * package they resolve to, transitively. An image's tag hashes this rather
 * than the whole lockfile, so a dependency change elsewhere in the repository
 * leaves the image, and the service running it, alone.
 *
 * `prod` matches `pnpm install --prod`: devDependencies are not installed.
 */
export function lockfileSlice(text: string, directories: readonly string[], { prod }: { prod: boolean }): string {
  // pnpm 11+ writes the pnpm it pins as a first document; the workspace is the last.
  const documents = parseAllDocuments(text);
  const lock = documents.at(-1)?.toJS() as Lockfile;
  const slice = new Map<string, unknown>([["settings", lock.settings], ["overrides", lock.overrides]]);

  const visitPackage = (key: string) => {
    if (slice.has(key)) return;
    const snapshot = lock.snapshots?.[key] ?? {};
    slice.set(key, snapshot);
    for (const [name, version] of Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies })) {
      visitPackage(packageKey(name, version));
    }
  };

  const visitImporter = (directory: string) => {
    const key = `importer ${directory}`;
    if (slice.has(key)) return;
    const importer = lock.importers[directory];
    if (!importer) throw new OpsError(`pnpm-lock.yaml has no workspace package at ${directory}`);
    const dependencies = {
      ...importer.dependencies,
      ...importer.optionalDependencies,
      ...(prod ? {} : importer.devDependencies),
    };
    slice.set(key, dependencies);
    for (const [name, { version }] of Object.entries(dependencies)) {
      if (version.startsWith("link:")) visitImporter(posix.join(directory, version.slice("link:".length)));
      else visitPackage(packageKey(name, version));
    }
  };

  for (const directory of directories) visitImporter(directory);
  return JSON.stringify([...slice].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A dependency's snapshot key: `name@version`, or the version itself for an npm alias (`other@1.0.0`). */
function packageKey(name: string, version: string): string {
  return !/^\d/.test(version) && version.lastIndexOf("@") > 0 ? version : `${name}@${version}`;
}

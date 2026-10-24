import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { AwsClient } from "aws4fetch";

/**
 * The sync server's R2 access, over the S3 API with the node's own credentials.
 *
 * `ObjectStore` is the whole surface the rest of the server needs, so
 * snapshot storage is tested against an in-memory store and only this file
 * speaks S3.
 */

export interface R2Config {
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
  bucketName: string;
}

export function hasR2Config(config: R2Config | undefined): config is R2Config {
  return Boolean(
    config?.accessKeyId && config.secretAccessKey && config.accountId && config.bucketName,
  );
}

export function buildR2Client(config: R2Config): { client: AwsClient; endpoint: string } {
  return {
    client: new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    }),
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
  };
}

export interface StoredObject {
  body: Uint8Array<ArrayBuffer>;
  metadata: Record<string, string>;
  etag?: string;
}

export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  /** Metadata only; null when the object does not exist. */
  head(key: string): Promise<Record<string, string> | null>;
  /** expectedEtag: null creates only; a string replaces exactly that version. */
  put(key: string, body: Uint8Array<ArrayBuffer>, metadata: Record<string, string>, expectedEtag?: string | null): Promise<void>;
  /** Server-side copy, metadata included. */
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  /** Remove an object; removing a missing one succeeds. */
  delete(key: string): Promise<void>;
  /** Every key under `prefix`. */
  list(prefix: string): Promise<string[]>;
}

class ObjectStoreError extends Error {
  readonly status: number;

  constructor(operation: string, key: string, status: number) {
    super(`R2 ${operation} ${key} failed (${status})`);
    this.status = status;
    this.name = "ObjectStoreError";
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const META_PREFIX = "x-amz-meta-";

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function metadataFromHeaders(headers: Headers): Record<string, string> {
  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith(META_PREFIX)) metadata[lower.slice(META_PREFIX.length)] = value;
  });
  return metadata;
}

export function createR2ObjectStore(config: R2Config): ObjectStore {
  const { client, endpoint } = buildR2Client(config);
  const objectUrl = (key: string) => `${endpoint}/${config.bucketName}/${encodeKey(key)}`;
  const send = (url: string, init: RequestInit) =>
    client.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  return {
    async get(key) {
      // R2 gzips JSON when the client accepts it and then answers with a weak
      // ETag (W/"…"), which a later If-Match never matches: every conditional
      // update of the object would fail with 412. Ask for the stored bytes.
      const response = await send(objectUrl(key), {
        method: "GET",
        headers: { "Accept-Encoding": "identity" },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new ObjectStoreError("GET", key, response.status);
      return {
        body: new Uint8Array(await response.arrayBuffer()),
        metadata: metadataFromHeaders(response.headers),
        etag: response.headers.get("etag") ?? undefined,
      };
    },
    async head(key) {
      const response = await send(objectUrl(key), { method: "HEAD" });
      if (response.status === 404) return null;
      if (!response.ok) throw new ObjectStoreError("HEAD", key, response.status);
      return metadataFromHeaders(response.headers);
    },
    async put(key, body, metadata, expectedEtag) {
      const headers = new Headers({ "Content-Type": "application/json" });
      for (const [name, value] of Object.entries(metadata)) headers.set(`${META_PREFIX}${name}`, value);
      if (expectedEtag === null) headers.set("If-None-Match", "*");
      else if (expectedEtag !== undefined) headers.set("If-Match", expectedEtag);
      const response = await send(objectUrl(key), { method: "PUT", headers, body });
      if (!response.ok) throw new ObjectStoreError("PUT", key, response.status);
    },
    async copy(sourceKey, destinationKey) {
      const response = await send(objectUrl(destinationKey), {
        method: "PUT",
        headers: {
          "x-amz-copy-source": `/${config.bucketName}/${encodeKey(sourceKey)}`,
          "x-amz-metadata-directive": "COPY",
        },
      });
      if (!response.ok) throw new ObjectStoreError("COPY", `${sourceKey} -> ${destinationKey}`, response.status);
    },
    async delete(key) {
      const response = await send(objectUrl(key), { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new ObjectStoreError("DELETE", key, response.status);
    },
    async list(prefix) {
      // S3 ListObjectsV2, a page at a time.
      const keys: string[] = [];
      let token: string | null = null;
      do {
        const url = new URL(`${endpoint}/${config.bucketName}`);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", prefix);
        if (token) url.searchParams.set("continuation-token", token);
        const response = await send(url.toString(), { method: "GET" });
        if (!response.ok) throw new ObjectStoreError("LIST", prefix, response.status);
        const xml = await response.text();
        for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(decodeXml(match[1]));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? decodeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "")
          : null;
      } while (token);
      return keys;
    },
  };
}

function bodyEtag(body: Uint8Array): string {
  return `"${createHash("sha256").update(body).digest("hex")}"`;
}

function assertExpected(key: string, actual: string | null, expected: string | null | undefined): void {
  if (expected !== undefined && actual !== expected) throw new ObjectStoreError("PUT", key, 412);
}

/** An in-memory store for tests and local development without R2. */
export function createMemoryObjectStore(): ObjectStore & { objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();
  return {
    objects,
    async get(key) {
      const object = objects.get(key);
      return object ? { body: object.body.slice(), metadata: { ...object.metadata }, etag: bodyEtag(object.body) } : null;
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { ...object.metadata } : null;
    },
    async put(key, body, metadata, expectedEtag) {
      const current = objects.get(key);
      assertExpected(key, current ? bodyEtag(current.body) : null, expectedEtag);
      objects.set(key, { body: body.slice(), metadata: { ...metadata } });
    },
    async copy(sourceKey, destinationKey) {
      const object = objects.get(sourceKey);
      if (!object) throw new ObjectStoreError("COPY", sourceKey, 404);
      objects.set(destinationKey, { body: object.body.slice(), metadata: { ...object.metadata } });
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
  };
}

/**
 * A directory standing in for R2 in local development. Keys map to files under
 * `dir`; metadata sits beside each object as `<file>.meta.json`.
 */
export function createFileObjectStore(dir: string): ObjectStore {
  const root = resolve(dir);
  const pathFor = (key: string) => {
    const path = resolve(join(root, key));
    if (!path.startsWith(root + sep)) throw new ObjectStoreError("RESOLVE", key, 400);
    return path;
  };
  const readMetadata = (path: string): Record<string, string> =>
    existsSync(`${path}.meta.json`)
      ? (JSON.parse(readFileSync(`${path}.meta.json`, "utf8")) as Record<string, string>)
      : {};
  const write = (path: string, body: Uint8Array, metadata: Record<string, string>) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    writeFileSync(`${path}.meta.json`, JSON.stringify(metadata));
  };
  return {
    async get(key) {
      const path = pathFor(key);
      if (!existsSync(path)) return null;
      const body = new Uint8Array(readFileSync(path));
      return { body, metadata: readMetadata(path), etag: bodyEtag(body) };
    },
    async head(key) {
      const path = pathFor(key);
      return existsSync(path) ? readMetadata(path) : null;
    },
    async put(key, body, metadata, expectedEtag) {
      const path = pathFor(key);
      // The development adapter is used under the local single-writer lock.
      assertExpected(key, existsSync(path) ? bodyEtag(readFileSync(path)) : null, expectedEtag);
      write(path, body, metadata);
    },
    async copy(sourceKey, destinationKey) {
      const source = pathFor(sourceKey);
      if (!existsSync(source)) throw new ObjectStoreError("COPY", sourceKey, 404);
      const destination = pathFor(destinationKey);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      writeFileSync(`${destination}.meta.json`, JSON.stringify(readMetadata(source)));
    },
    async delete(key) {
      const path = pathFor(key);
      rmSync(path, { force: true });
      rmSync(`${path}.meta.json`, { force: true });
    },
    async list(prefix) {
      const keys: string[] = [];
      const walk = (relative: string) => {
        const absolute = join(root, relative);
        if (!existsSync(absolute)) return;
        for (const entry of readdirSync(absolute, { withFileTypes: true })) {
          const key = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(key);
          else if (!entry.name.endsWith(".meta.json")) keys.push(key);
        }
      };
      walk("");
      return keys.filter((key) => key.startsWith(prefix)).sort();
    },
  };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

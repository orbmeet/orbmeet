import { beforeEach, describe, expect, it, vi } from "vitest";
import { files, spaces, uploadReservations, users } from "@orbmeet/db/schema";
import { createTestDb, type TestDb } from "@/test/db";
import {
  PROMOTION_INTENT_GRACE_MS,
  PROMOTION_INTENT_PREFIX,
  finalKeyFromPromotionIntent,
  promotionIntentKey,
  sweepUnregisteredPromotionIntents,
} from "./promotion-intent";
import { commitSpacePdfUpload } from "./finalize-space-pdf";
import { cleanupFileOperations } from "./file-maintenance";

const FINAL_KEY = "spaces/space_1/uploads/asset_1.pdf";
const STAGED_KEY = "staging/space-space_1-pdf/asset_1.pdf";
const OWNER = "owner";
// "%PDF-hello!" — the exact staged byte count the reservation must match.
const RESERVATION_BYTES = 11;

/**
 * In-memory R2 with an ordered op log, so tests can assert the reconciliation
 * intent is written before the promotion (the ordering the whole design hangs
 * on) and that the sweep deletes an object before ever deleting its marker.
 */
function storage() {
  type Stored = { bytes: Uint8Array; etag: string; uploaded: Date; customMetadata?: Record<string, string> };
  const objects = new Map<string, Stored>();
  const ops: string[] = [];
  let generation = 0;
  const describe = (key: string, object: Stored) => ({
    key,
    size: object.bytes.length,
    etag: object.etag,
    uploaded: object.uploaded,
    customMetadata: object.customMetadata,
  });
  const bucket = {
    head: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object ? describe(key, object) : null;
    }),
    get: vi.fn(async (key: string, options?: R2GetOptions) => {
      const object = objects.get(key);
      if (!object) return null;
      const onlyIf = options?.onlyIf as R2Conditional | undefined;
      if (onlyIf?.etagMatches && onlyIf.etagMatches !== object.etag) return describe(key, object);
      const range = options?.range as { length?: number } | undefined;
      const bytes = object.bytes.slice(0, range?.length);
      return {
        ...describe(key, object),
        body: new Response(bytes).body,
        arrayBuffer: async () => bytes.buffer,
      };
    }),
    put: vi.fn(async (key: string, value: BodyInit, options?: R2PutOptions) => {
      ops.push(`put ${key}`);
      const onlyIf = options?.onlyIf as Headers | undefined;
      if (onlyIf && objects.has(key)) return null;
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      const object: Stored = {
        bytes,
        etag: String(++generation),
        uploaded: new Date(),
        customMetadata: options?.customMetadata,
      };
      objects.set(key, object);
      return describe(key, object);
    }),
    delete: vi.fn(async (key: string) => {
      ops.push(`delete ${key}`);
      objects.delete(key);
    }),
    // Faithful to R2: keys come back in lexicographic order, `limit` caps the
    // page, and `cursor` resumes strictly after the key it names. The sweep's
    // whole correctness question is what happens past the first page, so a fake
    // that returned everything at once could not express it.
    list: vi.fn(async (options?: R2ListOptions) => {
      const matching = [...objects.entries()]
        .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      const after = options?.cursor
        ? matching.findIndex(([key]) => key > options.cursor!)
        : 0;
      const start = after < 0 ? matching.length : after;
      const limit = options?.limit ?? matching.length;
      const page = matching.slice(start, start + limit);
      const truncated = start + page.length < matching.length;
      return {
        objects: page.map(([key, object]) => describe(key, object)),
        truncated,
        ...(truncated ? { cursor: page[page.length - 1][0] } : {}),
      };
    }),
  };
  return {
    bucket: bucket as unknown as R2Bucket,
    mocks: bucket,
    objects,
    ops,
    write(key: string, text: string) {
      objects.set(key, {
        bytes: new TextEncoder().encode(text),
        etag: String(++generation),
        uploaded: new Date(),
      });
    },
    /** Fake object age without freezing time: backdate after writing. */
    backdate(key: string, ageMs: number) {
      const object = objects.get(key)!;
      object.uploaded = new Date(Date.now() - ageMs);
    },
  };
}

type Storage = ReturnType<typeof storage>;

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  const now = new Date();
  await db.insert(users).values({
    id: OWNER,
    name: "Owner",
    email: "owner@example.com",
    normalizedEmail: "owner@example.com",
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(spaces).values({
    id: "space_1",
    slug: "space-1",
    name: "Space",
    kind: "shared",
    ownerUserId: OWNER,
    createdAt: now,
    updatedAt: now,
  });
});

async function insertReservation(store: Storage) {
  store.write(STAGED_KEY, "%PDF-hello!");
  await db.insert(uploadReservations).values({
    id: "asset_1",
    principal: "user:owner",
    scope: "space-pdf:space_1",
    bytes: RESERVATION_BYTES,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
  });
}

function commitInput() {
  return {
    assetId: "asset_1",
    whiteboardId: undefined,
    spaceId: "space_1",
    filename: "handout.pdf",
    owner: OWNER,
    stagedR2Key: STAGED_KEY,
    r2Key: FINAL_KEY,
    reservationPrincipal: "user:owner",
    reservationScope: "space-pdf:space_1",
    expectedSize: RESERVATION_BYTES,
    maxSize: 50 * 1024 * 1024,
  };
}

/** Seed an intent marker past (or short of) the grace period. */
function seedIntent(store: Storage, finalKey = FINAL_KEY, ageMs = PROMOTION_INTENT_GRACE_MS + 3_600_000) {
  store.write(promotionIntentKey(finalKey), JSON.stringify({ finalKey }));
  store.backdate(promotionIntentKey(finalKey), ageMs);
}

describe("commitSpacePdfUpload", () => {
  it("writes the reconciliation intent before the permanent object exists", async () => {
    const store = storage();
    await insertReservation(store);

    await commitSpacePdfUpload(db, store.bucket, commitInput());

    const intentIndex = store.ops.indexOf(`put ${promotionIntentKey(FINAL_KEY)}`);
    const promoteIndex = store.ops.indexOf(`put ${FINAL_KEY}`);
    expect(intentIndex).toBeGreaterThanOrEqual(0);
    expect(promoteIndex).toBeGreaterThan(intentIndex);
  });

  it("commits the metadata and retires the intent and the staged copy", async () => {
    const store = storage();
    await insertReservation(store);

    const finalObject = await commitSpacePdfUpload(db, store.bucket, commitInput());

    expect(finalObject.size).toBe(RESERVATION_BYTES);
    const row = await db.query.files.findFirst({ where: { id: "asset_1" } });
    expect(row).toMatchObject({ r2Key: FINAL_KEY, status: "committed", size: RESERVATION_BYTES });
    expect(store.objects.has(promotionIntentKey(FINAL_KEY))).toBe(false);
    expect(store.objects.has(STAGED_KEY)).toBe(false);
    // The reservation was consumed with the commit, not leaked until TTL.
    await expect(db.select().from(uploadReservations)).resolves.toEqual([]);
  });

  it("promote-then-die: a failure after promotion leaves the intent and the object for the sweep", async () => {
    const store = storage();
    // No reservation row: promotion succeeds, the metadata commit cannot.
    store.write(STAGED_KEY, "%PDF-hello!");

    await expect(commitSpacePdfUpload(db, store.bucket, commitInput()))
      .rejects.toThrow("Failed to commit reserved asset");

    // The request path never compensated by deleting the final object...
    expect(store.ops).not.toContain(`delete ${FINAL_KEY}`);
    // ...but accountability survived: the intent names the promoted object.
    expect(store.objects.has(FINAL_KEY)).toBe(true);
    expect(store.objects.has(promotionIntentKey(FINAL_KEY))).toBe(true);
    await expect(db.query.files.findFirst({ where: { id: "asset_1" } })).resolves.toBeUndefined();
  });
});

describe("sweepUnregisteredPromotionIntents", () => {
  it("reaps a promoted object whose intent outlived the grace period without a file row", async () => {
    const store = storage();
    seedIntent(store);
    store.write(FINAL_KEY, "%PDF-hello!");

    await sweepUnregisteredPromotionIntents(db, store.bucket);

    expect(store.objects.has(FINAL_KEY)).toBe(false);
    expect(store.objects.has(promotionIntentKey(FINAL_KEY))).toBe(false);
    // The permanent object is always deleted before its last trace is removed.
    expect(store.ops.indexOf(`delete ${FINAL_KEY}`))
      .toBeLessThan(store.ops.indexOf(`delete ${promotionIntentKey(FINAL_KEY)}`));
  });

  it("keeps a registered object and only retires its stale intent", async () => {
    const store = storage();
    seedIntent(store);
    store.write(FINAL_KEY, "%PDF-hello!");
    await db.insert(files).values({
      id: "asset_1",
      spaceId: "space_1",
      type: "pdf",
      status: "committed",
      r2Key: FINAL_KEY,
      filename: "handout.pdf",
      mimeType: "application/pdf",
      size: RESERVATION_BYTES,
      uploadedByUserId: OWNER,
      committedAt: new Date(),
      createdAt: new Date(),
    });

    await sweepUnregisteredPromotionIntents(db, store.bucket);

    expect(store.objects.has(FINAL_KEY)).toBe(true);
    expect(store.objects.has(promotionIntentKey(FINAL_KEY))).toBe(false);
  });

  it("respects the grace period for an intent that may still be in flight", async () => {
    const store = storage();
    seedIntent(store, FINAL_KEY, PROMOTION_INTENT_GRACE_MS - 60_000);
    store.write(FINAL_KEY, "%PDF-hello!");

    await sweepUnregisteredPromotionIntents(db, store.bucket);

    expect(store.objects.has(FINAL_KEY)).toBe(true);
    expect(store.objects.has(promotionIntentKey(FINAL_KEY))).toBe(true);
  });

  it("retires a spent intent whose guarded object never existed", async () => {
    const store = storage();
    seedIntent(store);

    await sweepUnregisteredPromotionIntents(db, store.bucket);

    expect(store.objects.has(promotionIntentKey(FINAL_KEY))).toBe(false);
    expect(store.mocks.delete).not.toHaveBeenCalledWith(FINAL_KEY);
  });

  it("discards a marker key it cannot map to a guarded object", async () => {
    const store = storage();
    const malformed = `${PROMOTION_INTENT_PREFIX}meetings/m_1/recordings/e_1.mp4`;
    store.write(malformed, "{}");
    store.backdate(malformed, PROMOTION_INTENT_GRACE_MS + 3_600_000);

    await sweepUnregisteredPromotionIntents(db, store.bucket);

    expect(store.objects.has(malformed)).toBe(false);
  });

  // The regression: R2 lists lexicographically, not by age, and a marker inside
  // its grace period is skipped without costing any of the work budget. A page
  // full of young markers sorting ahead of an old one used to hide it from
  // every run, while the prefix lifecycle deleted it at seven days regardless.
  it("reconciles an old marker hidden behind a page of in-grace markers", async () => {
    const store = storage();
    // `spaces/…` sorts before `whiteboards/…`, so every one of these is listed
    // ahead of the stranded marker below.
    for (let index = 0; index < 600; index += 1) {
      const youngKey = `spaces/space_1/uploads/young_${String(index).padStart(4, "0")}.pdf`;
      seedIntent(store, youngKey, PROMOTION_INTENT_GRACE_MS - 60_000);
    }
    const strandedKey = "whiteboards/wb_1/assets/stranded_1.png";
    seedIntent(store, strandedKey);
    store.write(strandedKey, "stranded-bytes");

    await sweepUnregisteredPromotionIntents(db, store.bucket);

    // Unregistered and past its grace: object and marker both reaped.
    expect(store.objects.has(strandedKey)).toBe(false);
    expect(store.objects.has(promotionIntentKey(strandedKey))).toBe(false);
    // The in-grace markers are untouched, as their grace requires.
    expect(store.objects.has(
      promotionIntentKey("spaces/space_1/uploads/young_0000.pdf"),
    )).toBe(true);
  });

  it("bounds page reads and resumes after a young-marker backlog", async () => {
    const store = storage();
    for (let index = 0; index < 4_000; index += 1) {
      const youngKey = `spaces/space_1/uploads/young_${String(index).padStart(4, "0")}.pdf`;
      seedIntent(store, youngKey, PROMOTION_INTENT_GRACE_MS - 60_000);
    }
    const strandedKey = "whiteboards/wb_1/assets/stranded_after_page_budget.png";
    seedIntent(store, strandedKey);
    store.write(strandedKey, "stranded-bytes");

    await sweepUnregisteredPromotionIntents(db, store.bucket);

    expect(store.mocks.list).toHaveBeenCalledTimes(20);
    expect(store.objects.has(strandedKey)).toBe(true);

    await sweepUnregisteredPromotionIntents(db, store.bucket);

    expect(store.objects.has(strandedKey)).toBe(false);
    expect(store.objects.has(promotionIntentKey(strandedKey))).toBe(false);
  });

  it("advances past a full page of failing markers", async () => {
    const store = storage();
    const finalKeys = Array.from(
      { length: 201 },
      (_, index) => `spaces/space_1/uploads/stuck_${String(index).padStart(3, "0")}.pdf`,
    );
    for (const key of finalKeys) seedIntent(store, key);
    store.mocks.delete.mockRejectedValueOnce(new Error("R2 unavailable"));

    await expect(sweepUnregisteredPromotionIntents(db, store.bucket)).rejects.toThrow(
      AggregateError,
    );
    expect(store.objects.has(promotionIntentKey(finalKeys.at(-1)!))).toBe(true);

    await sweepUnregisteredPromotionIntents(db, store.bucket);

    expect(store.objects.has(promotionIntentKey(finalKeys.at(-1)!))).toBe(false);
  });

  it("reports a sweep failure instead of losing the marker", async () => {
    const store = storage();
    seedIntent(store);
    store.write(FINAL_KEY, "%PDF-hello!");
    store.mocks.delete.mockImplementationOnce(async () => {
      throw new Error("R2 unavailable");
    });

    await expect(sweepUnregisteredPromotionIntents(db, store.bucket)).rejects.toThrow(AggregateError);

    // Nothing was resolved: object and intent both remain for the next run.
    expect(store.objects.has(FINAL_KEY)).toBe(true);
    expect(store.objects.has(promotionIntentKey(FINAL_KEY))).toBe(true);
  });
});

describe("promotion-intent key mapping", () => {
  it("round-trips a space upload key and rejects every other namespace", () => {
    expect(finalKeyFromPromotionIntent(promotionIntentKey(FINAL_KEY))).toBe(FINAL_KEY);
    expect(finalKeyFromPromotionIntent(`${PROMOTION_INTENT_PREFIX}staging/space_1/asset_1.pdf`))
      .toBeNull();
    expect(finalKeyFromPromotionIntent(`${PROMOTION_INTENT_PREFIX}../../etc`)).toBeNull();
    expect(finalKeyFromPromotionIntent("spaces/space_1/uploads/asset_1.pdf")).toBeNull();
  });
});

describe("cleanupFileOperations trigger", () => {
  it("runs the promotion-intent sweep on the existing file-maintenance path", async () => {
    const store = storage();
    seedIntent(store);
    store.write(FINAL_KEY, "%PDF-hello!");

    // No `deleting` rows: the deletion half has nothing to do, and the sweep
    // still reconciles the stranded promotion.
    await cleanupFileOperations(db, { R2_BUCKET: store.bucket } as unknown as Env);

    expect(store.objects.has(FINAL_KEY)).toBe(false);
    expect(store.objects.has(promotionIntentKey(FINAL_KEY))).toBe(false);
  });
});

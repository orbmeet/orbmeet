import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb, type TestDb } from '@/test/db'
import { maybeRefreshSession } from './session.ts'
import { users, sessions } from '@orbmeet/db/schema'
import { eq } from 'drizzle-orm'
import { SESSION_EXPIRY_MS, SESSION_REFRESH_THRESHOLD_MS } from "@/modules/identity/contract/auth/constants";

let db: TestDb
const getAppDb = () => db

beforeEach(async () => {
  db = await createTestDb()
})

// Generate a valid 64-character hex hash for tests (SHA-256 length)
function testHash(seed: string): string {
  // Convert seed to hex and pad to 64 chars
  let hex = ''
  for (const char of seed) {
    hex += char.charCodeAt(0).toString(16).padStart(2, '0')
  }
  return (hex + 'a'.repeat(64)).slice(0, 64)
}

// Minimal mock env — maybeRefreshSession only uses APP_URL and ENVIRONMENT
const mockEnv = {
  APP_URL: 'http://localhost:3000',
  ENVIRONMENT: 'development',
} as unknown as Env

async function insertUser(id = 'usr_test') {
  const now = new Date()
  await db.insert(users).values({
    id,
    name: 'Test',
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    image: null,
    plan: 'free',
    role: 'user',
    createdAt: now,
    updatedAt: now,
  })
}

async function insertSession(opts: {
  id?: string
  userId?: string
  tokenHash?: string
  previousTokenHash?: string
  previousTokenExpiresAt?: Date
  expiresAt: Date
  absoluteExpiresAt?: Date
  rotationVersion?: number
}) {
  const id = opts.id ?? `ses_${crypto.randomUUID()}`
  const userId = opts.userId ?? 'usr_test'
  const now = new Date()
  await db.insert(sessions).values({
    id,
    tokenHash: opts.tokenHash ?? testHash(id),
    previousTokenHash: opts.previousTokenHash ?? null,
    previousTokenExpiresAt: opts.previousTokenHash
      ? (opts.previousTokenExpiresAt ?? new Date(Date.now() + 120_000))
      : null,
    userId,
    expiresAt: opts.expiresAt,
    absoluteExpiresAt: opts.absoluteExpiresAt ?? new Date(opts.expiresAt.getTime() + 60 * 86_400_000),
    rotationVersion: opts.rotationVersion ?? 0,
    ipAddress: null,
    userAgent: null,
    createdAt: now,
  })
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .limit(1)
  if (!row) throw new Error('Inserted session not found')
  return { ...row.session, user: row.user }
}

describe('maybeRefreshSession', () => {
  it('returns same session and null cookie when expiry is well in the future', async () => {
    await insertUser()
    const farFuture = new Date(Date.now() + SESSION_EXPIRY_MS)
    const session = await insertSession({ expiresAt: farFuture })
    const { session: result, setCookie } = await maybeRefreshSession(session, mockEnv, getAppDb(), false)
    expect(setCookie).toBeNull()
    expect(result.id).toBe(session.id)
    expect(result.tokenHash).toBe(session.tokenHash)
  })

  it('rotates token when session is within the refresh threshold', async () => {
    await insertUser()
    // Set expiry to within threshold window (e.g. 1 day from now, threshold is 7 days)
    const nearExpiry = new Date(Date.now() + SESSION_REFRESH_THRESHOLD_MS - 60_000)
    const session = await insertSession({ expiresAt: nearExpiry })
    const originalHash = session.tokenHash

    const { session: result, setCookie } = await maybeRefreshSession(session, mockEnv, getAppDb(), false)
    expect(setCookie).not.toBeNull()
    expect(result.tokenHash).not.toBe(originalHash)
  })

  it('increments rotationVersion after a rotation', async () => {
    await insertUser()
    const nearExpiry = new Date(Date.now() + SESSION_REFRESH_THRESHOLD_MS - 60_000)
    const session = await insertSession({ expiresAt: nearExpiry, rotationVersion: 2 })

    await maybeRefreshSession(session, mockEnv, getAppDb(), false)
    const updated = await db.query.sessions.findFirst({ where: { id: session.id } })
    expect(updated!.rotationVersion).toBe(3)
  })

  it('stores old tokenHash in previousTokenHash after rotation', async () => {
    await insertUser()
    const nearExpiry = new Date(Date.now() + SESSION_REFRESH_THRESHOLD_MS - 60_000)
    const oldHash = testHash('old_hash_value')
    const session = await insertSession({ expiresAt: nearExpiry, tokenHash: oldHash })

    await maybeRefreshSession(session, mockEnv, getAppDb(), false)
    const updated = await db.query.sessions.findFirst({ where: { id: session.id } })
    expect(updated!.previousTokenHash).toBe(oldHash)
    expect(updated!.previousTokenExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 120_000)
  })

  it('returned cookie string contains the new token', async () => {
    await insertUser()
    const nearExpiry = new Date(Date.now() + SESSION_REFRESH_THRESHOLD_MS - 60_000)
    const session = await insertSession({ expiresAt: nearExpiry })

    const { setCookie } = await maybeRefreshSession(session, mockEnv, getAppDb(), false)
    expect(setCookie).toContain('session=')
    expect(setCookie).toContain('HttpOnly')
  })

  it('skips rotation if rotationVersion was bumped concurrently (CAS)', async () => {
    await insertUser()
    const nearExpiry = new Date(Date.now() + SESSION_REFRESH_THRESHOLD_MS - 60_000)
    const session = await insertSession({ expiresAt: nearExpiry, rotationVersion: 1 })

    // Simulate concurrent rotation: bump rotationVersion in DB before our call resolves
    await db.update(sessions).set({ rotationVersion: 2 }).where(eq(sessions.id, session.id))

    // The session object still has rotationVersion=1 (stale), CAS should detect the conflict
    const { setCookie } = await maybeRefreshSession(session, mockEnv, getAppDb(), false)
    // CAS failed: no new cookie issued
    expect(setCookie).toBeNull()
  })

  it('does not rotate or extend the session when matched through the short previous-token grace', async () => {
    await insertUser()
    const farFuture = new Date(Date.now() + SESSION_EXPIRY_MS)
    const currentHash = testHash('current_hash')
    const oldHash = testHash('old_hash')
    const session = await insertSession({ expiresAt: farFuture, tokenHash: currentHash, previousTokenHash: oldHash })

    const { setCookie } = await maybeRefreshSession(session, mockEnv, getAppDb(), true)
    // No new cookie issued — the canonical token already belongs to the rotator,
    // and rotating again would evict this client's still-valid previous token.
    expect(setCookie).toBeNull()

    const updated = await db.query.sessions.findFirst({ where: { id: session.id } })
    expect(updated!.tokenHash).toBe(currentHash)
    expect(updated!.previousTokenHash).toBe(oldHash)
    expect(Math.abs(updated!.expiresAt.getTime() - farFuture.getTime())).toBeLessThan(1_000)
  })

  it('caps the refreshed expiry at the absolute expiry', async () => {
    await insertUser()
    const now = Date.now()
    const nearExpiry = new Date(now + 30_000)
    const absoluteExpiresAt = new Date(now + 60_000)
    const session = await insertSession({
      expiresAt: nearExpiry,
      absoluteExpiresAt,
    })

    const { session: result, setCookie } = await maybeRefreshSession(session, mockEnv, getAppDb(), false)

    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(absoluteExpiresAt.getTime())
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(absoluteExpiresAt.getTime() - 1_000)
    expect(setCookie).toContain('Max-Age=')
  })

  it('does not rotate again after expiry has reached the absolute cap', async () => {
    await insertUser()
    const absoluteExpiresAt = new Date(Date.now() + 60_000)
    const tokenHash = testHash('at_absolute_cap')
    const session = await insertSession({
      expiresAt: absoluteExpiresAt,
      absoluteExpiresAt,
      tokenHash,
      rotationVersion: 4,
    })

    const { setCookie } = await maybeRefreshSession(session, mockEnv, getAppDb(), false)
    expect(setCookie).toBeNull()
    await expect(db.query.sessions.findFirst({ where: { id: session.id } }))
      .resolves.toMatchObject({ tokenHash, rotationVersion: 4 })
  })
})

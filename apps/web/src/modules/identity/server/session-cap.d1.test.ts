import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb, type TestDb } from '@/test/db'
import { enforceSessionCap } from './session.ts'
import { users, sessions } from '@orbmeet/db/schema'
import { eq } from 'drizzle-orm'

let db: TestDb
const getAppDb = () => db

beforeEach(async () => {
  db = await createTestDb()
})

// Generate a valid 64-character hex hash for tests (SHA-256 length)
function testHash(seed: string): string {
  let hex = ''
  for (const char of seed) {
    hex += char.charCodeAt(0).toString(16).padStart(2, '0')
  }
  return (hex + 'a'.repeat(64)).slice(0, 64)
}

async function insertUser(id: string) {
  const now = new Date()
  await db.insert(users).values({
    id,
    name: 'Test User',
    email: `${id}@example.com`,
    normalizedEmail: `${id}@example.com`,
    image: null,
    plan: 'free',
    role: 'user',
    createdAt: now,
    updatedAt: now,
  })
}

async function insertSessions(userId: string, count: number) {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = `ses_${userId}_${i}`
    ids.push(id)
    // Spread createdAt so ordering is deterministic (oldest first = index 0)
    const createdAt = new Date(Date.now() - (count - i) * 1000)
    await db.insert(sessions).values({
      id,
      tokenHash: testHash(`${userId}_${i}`),
      userId,
      expiresAt: new Date(Date.now() + 86_400_000),
      absoluteExpiresAt: new Date(Date.now() + 90 * 86_400_000),
      ipAddress: null,
      userAgent: null,
      createdAt,
    })
  }
  return ids
}

async function countSessions(userId: string): Promise<number> {
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))
  return rows.length
}

describe('enforceSessionCap', () => {
  it('does nothing when session count is exactly at the cap (10)', async () => {
    await insertUser('usr_a')
    await insertSessions('usr_a', 10)
    await enforceSessionCap(getAppDb(), 'usr_a')
    expect(await countSessions('usr_a')).toBe(10)
  })

  it('does nothing when session count is below cap', async () => {
    await insertUser('usr_b')
    await insertSessions('usr_b', 5)
    await enforceSessionCap(getAppDb(), 'usr_b')
    expect(await countSessions('usr_b')).toBe(5)
  })

  it('evicts 1 session when count is 11', async () => {
    await insertUser('usr_c')
    await insertSessions('usr_c', 11)
    await enforceSessionCap(getAppDb(), 'usr_c')
    expect(await countSessions('usr_c')).toBe(10)
  })

  it('evicts 5 sessions when count is 15', async () => {
    await insertUser('usr_d')
    await insertSessions('usr_d', 15)
    await enforceSessionCap(getAppDb(), 'usr_d')
    expect(await countSessions('usr_d')).toBe(10)
  })

  it('evicts the oldest sessions (smallest createdAt)', async () => {
    await insertUser('usr_e')
    const ids = await insertSessions('usr_e', 12) // ids[0] is oldest
    await enforceSessionCap(getAppDb(), 'usr_e')
    // The 2 oldest should be gone
    const remaining = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, 'usr_e'))
    const remainingIds = new Set(remaining.map((r) => r.id))
    expect(remainingIds.has(ids[0])).toBe(false)
    expect(remainingIds.has(ids[1])).toBe(false)
    expect(remainingIds.has(ids[11])).toBe(true) // newest kept
  })

  it('does not evict sessions belonging to other users', async () => {
    await insertUser('usr_f')
    await insertUser('usr_g')
    await insertSessions('usr_f', 12)
    await insertSessions('usr_g', 3)
    await enforceSessionCap(getAppDb(), 'usr_f')
    // usr_g untouched
    expect(await countSessions('usr_g')).toBe(3)
  })

  it('does not throw when user has no sessions', async () => {
    await insertUser('usr_h')
    await expect(enforceSessionCap(getAppDb(), 'usr_h')).resolves.toBeUndefined()
  })
})

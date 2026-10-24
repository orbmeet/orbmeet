import { createDb, type Database } from '@orbmeet/db'
import { env } from 'cloudflare:workers'

/**
 * Return the production Drizzle adapter over the test's isolated D1 binding.
 * The D1 setup file resets storage and applies migrations before every test.
 */
export async function createTestDb(): Promise<Database> {
  return createDb(env.DB)
}

export type TestDb = Database

import { describe, it, expect } from 'vitest'
import {
  hashSessionToken,
  generateSessionToken,
} from './tokens.server.ts'

describe('hashSessionToken', () => {
  it('is deterministic for the same input', async () => {
    const h1 = await hashSessionToken('my-token')
    const h2 = await hashSessionToken('my-token')
    expect(h1).toBe(h2)
  })

  it('produces different hashes for different inputs', async () => {
    const h1 = await hashSessionToken('token-a')
    const h2 = await hashSessionToken('token-b')
    expect(h1).not.toBe(h2)
  })

  it('returns a 64-char lowercase hex string (SHA-256)', async () => {
    const hash = await hashSessionToken('test')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('generateSessionToken', () => {
  it('returns a 64-char lowercase hex string', () => {
    const token = generateSessionToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates unique tokens', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateSessionToken()))
    expect(tokens.size).toBe(20)
  })
})

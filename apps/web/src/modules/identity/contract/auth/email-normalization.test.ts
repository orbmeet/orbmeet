import { describe, it, expect } from 'vitest'
import { normalizeEmail } from './email-normalization.ts'

describe('normalizeEmail', () => {
  it('lowercases the entire address', () => {
    expect(normalizeEmail('User@Example.COM')).toBe('user@example.com')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com')
  })

  it('drops a trailing DNS-root dot so it is not a separate identity', () => {
    expect(normalizeEmail('user@example.com.')).toBe('user@example.com')
    // And it still reaches the provider rules underneath the trailing dot.
    expect(normalizeEmail('test.user@gmail.com.')).toBe('testuser@gmail.com')
  })

  it('strips dots from gmail local part', () => {
    expect(normalizeEmail('test.user@gmail.com')).toBe('testuser@gmail.com')
    expect(normalizeEmail('t.e.s.t@gmail.com')).toBe('test@gmail.com')
  })

  it('strips +alias from gmail and canonicalizes to gmail.com', () => {
    expect(normalizeEmail('testuser+tag@gmail.com')).toBe('testuser@gmail.com')
    expect(normalizeEmail('test.user+news@gmail.com')).toBe('testuser@gmail.com')
  })

  it('normalizes googlemail.com to gmail.com', () => {
    expect(normalizeEmail('user@googlemail.com')).toBe('user@gmail.com')
    expect(normalizeEmail('test.user+tag@googlemail.com')).toBe('testuser@gmail.com')
  })

  it('strips +alias from known alias providers', () => {
    expect(normalizeEmail('user+tag@outlook.com')).toBe('user@outlook.com')
    expect(normalizeEmail('user+tag@hotmail.com')).toBe('user@hotmail.com')
    expect(normalizeEmail('user+tag@live.com')).toBe('user@live.com')
    expect(normalizeEmail('user+tag@fastmail.com')).toBe('user@fastmail.com')
  })

  it('does not strip +alias for unknown domains', () => {
    expect(normalizeEmail('user+tag@example.com')).toBe('user+tag@example.com')
    expect(normalizeEmail('user+tag@company.org')).toBe('user+tag@company.org')
  })

  it('does not strip dots for non-gmail domains', () => {
    expect(normalizeEmail('test.user@outlook.com')).toBe('test.user@outlook.com')
    expect(normalizeEmail('test.user@example.com')).toBe('test.user@example.com')
  })

  it('handles already-normalized email unchanged', () => {
    expect(normalizeEmail('user@example.com')).toBe('user@example.com')
  })

  it('does not truncate malformed addresses containing multiple @ signs', () => {
    expect(normalizeEmail('User@Example.com@attacker.test'))
      .toBe('user@example.com@attacker.test')
  })
})

describe('normalizeEmail with an alias-only local part', () => {
  it('does not collapse distinct addresses onto a bare domain', () => {
    // `'+foo'.split('+')[0]` is empty, and returning `@gmail.com` made every
    // alias-only local part — at every alias-stripping domain — normalize to
    // the same identity.
    expect(normalizeEmail('+foo@gmail.com')).toBe('+foo@gmail.com')
    expect(normalizeEmail('+bar@gmail.com')).toBe('+bar@gmail.com')
    expect(normalizeEmail('+foo@googlemail.com')).toBe('+foo@googlemail.com')
    expect(normalizeEmail('+foo@outlook.com')).toBe('+foo@outlook.com')
    expect(normalizeEmail('...@gmail.com')).toBe('...@gmail.com')
  })
})

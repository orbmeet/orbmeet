import { describe, it, expect } from 'vitest'
import { generateOtp } from './crypto.ts'

describe('generateOtp', () => {
  it('returns a six-digit string', () => {
    expect(generateOtp()).toHaveLength(6)
  })

  it('uses only numeric characters', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateOtp()).toMatch(/^\d{6}$/)
    }
  })

  it('generates distinct values', () => {
    const otps = new Set(Array.from({ length: 50 }, () => generateOtp()))
    expect(otps.size).toBeGreaterThan(40)
  })
})

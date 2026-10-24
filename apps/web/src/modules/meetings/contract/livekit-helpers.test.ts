import { describe, it, expect } from 'vitest'
import { isExpectedClosedPublishError } from './livekit-helpers.ts'

describe('isExpectedClosedPublishError', () => {
  it('returns true for PC manager is closed', () => {
    expect(isExpectedClosedPublishError(new Error('PC Manager is closed'))).toBe(true)
  })

  it('returns true for UnexpectedConnectionState (case-insensitive)', () => {
    expect(isExpectedClosedPublishError(new Error('UnexpectedConnectionState occurred'))).toBe(true)
  })

  it('returns true for Unexpected connection state with spaces', () => {
    expect(isExpectedClosedPublishError(new Error('Unexpected connection state'))).toBe(true)
  })

  it('returns true for not connected', () => {
    expect(isExpectedClosedPublishError(new Error('not connected'))).toBe(true)
  })

  it('returns false for unrelated error message', () => {
    expect(isExpectedClosedPublishError(new Error('network timeout'))).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(isExpectedClosedPublishError('string error')).toBe(false)
    expect(isExpectedClosedPublishError(null)).toBe(false)
    expect(isExpectedClosedPublishError(42)).toBe(false)
  })
})

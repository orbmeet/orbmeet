import * as v from 'valibot'
import { describe, it, expect } from 'vitest'
import {
  joinMeetingSchema,
  setRecordingSchema,
  setStreamingSchema,
  createMeetingSchema,
} from './schemas.ts'

const attempt = { clientAttemptId: '6b3a2c1e-9f0d-4a8b-8c7e-1d2f3a4b5c6d' }

describe('joinMeetingSchema', () => {
  it('accepts a standard random code', () => {
    expect(v.safeParse(joinMeetingSchema, { code: 'abc-defg-hij', ...attempt }).success).toBe(true)
  })

  it('rejects uppercase code', () => {
    expect(v.safeParse(joinMeetingSchema, { code: 'ABC-DEFG-HIJ', ...attempt }).success).toBe(false)
  })

  it('rejects wrong segment lengths', () => {
    expect(v.safeParse(joinMeetingSchema, { code: 'ab-defg-hij', ...attempt }).success).toBe(false)
    expect(v.safeParse(joinMeetingSchema, { code: 'abc-def-hij', ...attempt }).success).toBe(false)
    expect(v.safeParse(joinMeetingSchema, { code: 'abc-defg-hi', ...attempt }).success).toBe(false)
  })

  it('rejects code with numbers', () => {
    expect(v.safeParse(joinMeetingSchema, { code: 'abc-1234-hij', ...attempt }).success).toBe(false)
  })

  it('rejects code with special characters', () => {
    expect(v.safeParse(joinMeetingSchema, { code: 'abc_defg_hij', ...attempt }).success).toBe(false)
  })

  it('requires a client attempt id, so a retried request can be recognized', () => {
    expect(v.safeParse(joinMeetingSchema, { code: 'abc-defg-hij' }).success).toBe(false)
  })

  it('accepts optional displayName', () => {
    expect(v.safeParse(joinMeetingSchema, { code: 'abc-defg-hij', displayName: 'Alice', ...attempt }).success).toBe(true)
  })
})

describe('setRecordingSchema', () => {
  it('accepts turning recording on and off', () => {
    expect(v.safeParse(setRecordingSchema, { meetingId: 'msn_1', on: true }).success).toBe(true)
    expect(v.safeParse(setRecordingSchema, { meetingId: 'msn_1', on: false }).success).toBe(true)
  })

  it('rejects a missing switch', () => {
    expect(v.safeParse(setRecordingSchema, { meetingId: 'msn_1' }).success).toBe(false)
  })
})

describe('setStreamingSchema', () => {
  it('accepts built-in streaming platforms', () => {
    expect(
      v.safeParse(setStreamingSchema, {
        meetingId: 'msn_1',
        on: true,
        platform: 'kick',
        streamKey: 'live_123',
      }).success,
    ).toBe(true)
  })

  it('accepts custom RTMP destinations', () => {
    expect(
      v.safeParse(setStreamingSchema, {
        meetingId: 'msn_1',
        on: true,
        platform: 'instagram',
        streamKey: 'rtmps://stream.example.com/app/live_123',
      }).success,
    ).toBe(true)
  })

  it('rejects URL metacharacters in fixed-host stream keys', () => {
    expect(
      v.safeParse(setStreamingSchema, {
        meetingId: 'msn_1',
        on: true,
        platform: 'youtube',
        streamKey: 'live_123?unexpected=true',
      }).success,
    ).toBe(false)
    expect(
      v.safeParse(setStreamingSchema, {
        meetingId: 'msn_1',
        on: true,
        platform: 'twitch',
        streamKey: 'live/123',
      }).success,
    ).toBe(false)
  })

  it('rejects unknown streaming platforms', () => {
    expect(
      v.safeParse(setStreamingSchema, {
        meetingId: 'msn_1',
        on: true,
        platform: 'unknown',
        streamKey: 'live_123',
      }).success,
    ).toBe(false)
  })
})

describe('createMeetingSchema', () => {
  it('accepts empty input (all optional)', () => {
    expect(v.safeParse(createMeetingSchema, {}).success).toBe(true)
  })

  it('defaults allowGuests to true', () => {
    const result = v.safeParse(createMeetingSchema, {})
    expect(result.success && result.output.allowGuests).toBe(true)
  })

  it('rejects title over 200 chars', () => {
    expect(v.safeParse(createMeetingSchema, { title: 'a'.repeat(201) }).success).toBe(false)
  })

  it('holds titles to the same rule as scheduled meetings', () => {
    expect(v.parse(createMeetingSchema, { title: ' Stand-up\n ' }).title).toBe('Stand-up')
  })
})

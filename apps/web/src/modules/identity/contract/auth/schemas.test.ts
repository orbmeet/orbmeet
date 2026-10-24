import * as v from 'valibot'
import { describe, it, expect } from 'vitest'
import {
  otpVerifySchema,
  deleteAccountSchema,
  updateProfileSchema,
} from './schemas.ts'

describe('otpVerifySchema', () => {
  const valid = {
    flowToken: `123e4567-e89b-42d3-a456-426614174000.${'a'.repeat(64)}`,
    otp: '123456',
  }

  it('accepts a valid flow token and six-digit code', () => {
    expect(v.safeParse(otpVerifySchema, valid).success).toBe(true)
  })

  it('rejects non-numeric code characters', () => {
    expect(v.safeParse(otpVerifySchema, { ...valid, otp: '12345A' }).success).toBe(false)
  })

  it('rejects a malformed flow token', () => {
    expect(v.safeParse(otpVerifySchema, { ...valid, flowToken: 'not-a-flow' }).success).toBe(false)
  })

  it('rejects codes of the wrong length', () => {
    expect(v.safeParse(otpVerifySchema, { ...valid, otp: '12345' }).success).toBe(false)
  })
})

describe('deleteAccountSchema', () => {
  it('accepts confirmation DELETE with valid OTP', () => {
    expect(v.safeParse(deleteAccountSchema, {
      confirmation: 'DELETE',
      credential: {
        flowToken: `123e4567-e89b-42d3-a456-426614174000.${'a'.repeat(64)}`,
        otp: '123456',
      },
    }).success).toBe(true)
  })

  it('rejects invalid OTP format', () => {
    expect(v.safeParse(deleteAccountSchema, {
      confirmation: 'DELETE',
      credential: { flowToken: 'bad', otp: 'abc123' },
    }).success).toBe(false)
  })

  it('rejects lowercase delete', () => {
    expect(v.safeParse(deleteAccountSchema, {
      confirmation: 'delete',
      credential: {
        flowToken: `123e4567-e89b-42d3-a456-426614174000.${'a'.repeat(64)}`,
        otp: '123456',
      },
    }).success).toBe(false)
  })

  it('rejects any other confirmation string', () => {
    expect(v.safeParse(deleteAccountSchema, {
      confirmation: 'yes',
      credential: {
        flowToken: `123e4567-e89b-42d3-a456-426614174000.${'a'.repeat(64)}`,
        otp: '123456',
      },
    }).success).toBe(false)
  })

  // A resumed attempt (deletion-pending recovery page) already crossed the
  // step-up boundary on its first run and authorizes through the retained
  // continuation session, so the credential — and therefore the OTP — is
  // optional at the validation boundary. The handler still requires one
  // whenever the deletion gate was not already set.
  it('accepts a credential-free body for a resumed attempt', () => {
    expect(v.safeParse(deleteAccountSchema, { confirmation: 'DELETE' }).success).toBe(true)
  })

  it('still rejects a malformed credential when one is supplied', () => {
    expect(v.safeParse(deleteAccountSchema, {
      confirmation: 'DELETE',
      credential: { flowToken: 'bad', otp: '123456' },
    }).success).toBe(false)
  })
})

describe('updateProfileSchema', () => {
  it('accepts valid name', () => {
    expect(v.safeParse(updateProfileSchema, { name: 'Bob' }).success).toBe(true)
  })

  it('accepts an IANA home time zone', () => {
    expect(v.safeParse(updateProfileSchema, { name: 'Bob', timeZone: 'Asia/Dhaka' }).success).toBe(true)
  })

  it('rejects an invalid home time zone', () => {
    expect(v.safeParse(updateProfileSchema, { name: 'Bob', timeZone: 'Dhaka' }).success).toBe(false)
  })

  it('rejects empty name', () => {
    expect(v.safeParse(updateProfileSchema, { name: '' }).success).toBe(false)
  })

  it('rejects name over 100 chars', () => {
    expect(v.safeParse(updateProfileSchema, { name: 'a'.repeat(101) }).success).toBe(false)
  })
})

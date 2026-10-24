import * as v from 'valibot'
import { describe, it, expect } from 'vitest'
import {
  createSpaceSchema,
  addMemberByEmailSchema,
  joinViaInviteSchema,
  updateSpaceSchema,
} from './schemas.ts'

describe('createSpaceSchema', () => {
  it('accepts valid input', () => {
    expect(v.safeParse(createSpaceSchema, { name: 'My Space' }).success).toBe(true)
  })

  it('accepts optional description', () => {
    expect(v.safeParse(createSpaceSchema, { name: 'My Space', description: 'A description' }).success).toBe(true)
  })

  it('rejects empty name', () => {
    expect(v.safeParse(createSpaceSchema, { name: '' }).success).toBe(false)
  })

  it('rejects whitespace-only name', () => {
    expect(v.safeParse(createSpaceSchema, { name: '   ' }).success).toBe(false)
  })

  it('rejects name over 200 chars', () => {
    expect(v.safeParse(createSpaceSchema, { name: 'a'.repeat(201) }).success).toBe(false)
  })

  it('rejects description over 1000 chars', () => {
    expect(v.safeParse(createSpaceSchema, { name: 'ok', description: 'a'.repeat(1001) }).success).toBe(false)
  })
})

describe('updateSpaceSchema', () => {
  it('accepts valid input with spaceId', () => {
    expect(v.safeParse(updateSpaceSchema, {
      spaceId: 'spc_1',
      name: 'New Name',
      expected: { name: 'Old Name', description: null, timeZone: 'UTC' },
    }).success).toBe(true)
  })

  it('rejects missing spaceId', () => {
    expect(v.safeParse(updateSpaceSchema, { name: 'New Name' }).success).toBe(false)
  })
})

describe('addMemberByEmailSchema', () => {
  it('accepts valid email', () => {
    expect(v.safeParse(addMemberByEmailSchema, { spaceId: 'spc_1', email: 'user@example.com' }).success).toBe(true)
  })

  it('rejects invalid email', () => {
    expect(v.safeParse(addMemberByEmailSchema, { spaceId: 'spc_1', email: 'notanemail' }).success).toBe(false)
  })
})

describe('joinViaInviteSchema', () => {
  it('accepts a valid token', () => {
    expect(v.safeParse(joinViaInviteSchema, { token: 'abc123' }).success).toBe(true)
  })

  it('rejects empty token', () => {
    expect(v.safeParse(joinViaInviteSchema, { token: '' }).success).toBe(false)
  })
})

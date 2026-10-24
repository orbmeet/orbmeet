import { describe, it, expect } from 'vitest'
import { AppError, Errors, createValidationError } from './app-errors.ts'

describe('AppError', () => {
  it('is an instance of Error', () => {
    const err = new AppError('CODE', 'message', 400)
    expect(err).toBeInstanceOf(Error)
  })

  it('has name AppError', () => {
    const err = new AppError('CODE', 'message', 400)
    expect(err.name).toBe('AppError')
  })

  it('stores code, message, and statusCode', () => {
    const err = new AppError('MY_CODE', 'my message', 422)
    expect(err.code).toBe('MY_CODE')
    expect(err.message).toBe('my message')
    expect(err.statusCode).toBe(422)
  })

  it('defaults statusCode to 500', () => {
    const err = new AppError('CODE', 'message')
    expect(err.statusCode).toBe(500)
  })
})

describe('Errors', () => {
  it('UNAUTHORIZED returns 401', () => {
    const err = Errors.UNAUTHORIZED()
    expect(err.code).toBe('UNAUTHORIZED')
    expect(err.statusCode).toBe(401)
  })

  it('FORBIDDEN returns 403', () => {
    const err = Errors.FORBIDDEN()
    expect(err.statusCode).toBe(403)
  })

  it('NOT_FOUND uses default resource name', () => {
    const err = Errors.NOT_FOUND()
    expect(err.statusCode).toBe(404)
    expect(err.message).toContain('Resource')
  })

  it('NOT_FOUND uses custom resource name', () => {
    const err = Errors.NOT_FOUND('User')
    expect(err.message).toContain('User')
  })

  it('RATE_LIMITED returns 429', () => {
    const err = Errors.RATE_LIMITED()
    expect(err.statusCode).toBe(429)
    expect(err.code).toBe('RATE_LIMITED')
  })

  it('PLAN_LIMIT_REACHED includes limit in message', () => {
    const err = Errors.PLAN_LIMIT_REACHED('maxSpaces')
    expect(err.statusCode).toBe(403)
    expect(err.message).toContain('maxSpaces')
    expect(err.code).toBe('PLAN_LIMIT_REACHED')
  })

  it('VALIDATION returns 400 with VALIDATION_ERROR code', () => {
    const err = Errors.VALIDATION('bad input')
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.message).toBe('bad input')
  })

  it('TEMPORARY_EMAIL returns 400', () => {
    const err = Errors.TEMPORARY_EMAIL()
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('TEMPORARY_EMAIL')
  })

  it('OAUTH_ERROR returns 400', () => {
    const err = Errors.OAUTH_ERROR('oauth failed')
    expect(err.statusCode).toBe(400)
    expect(err.message).toBe('oauth failed')
  })

  it('CONFIG_ERROR returns 500', () => {
    const err = Errors.CONFIG_ERROR('missing env var')
    expect(err.statusCode).toBe(500)
  })
})

describe('createValidationError', () => {
  it('is equivalent to Errors.VALIDATION', () => {
    const a = createValidationError('test')
    const b = Errors.VALIDATION('test')
    expect(a.code).toBe(b.code)
    expect(a.statusCode).toBe(b.statusCode)
    expect(a.message).toBe(b.message)
  })
})

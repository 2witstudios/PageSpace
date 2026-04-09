import { describe, test, expect } from 'vitest'
import { validateSlug, validateEmail, validateTier } from '../tenant-validation'

describe('validateSlug', () => {
  test('given a valid slug, should return valid', () => {
    const result = validateSlug('my-tenant')
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  test('given a simple alphanumeric slug, should return valid', () => {
    const result = validateSlug('acme')
    expect(result.valid).toBe(true)
  })

  test('given a slug with numbers, should return valid', () => {
    const result = validateSlug('tenant42')
    expect(result.valid).toBe(true)
  })

  test('given a slug at minimum length (3 chars), should return valid', () => {
    const result = validateSlug('abc')
    expect(result.valid).toBe(true)
  })

  test('given a slug at maximum length (63 chars), should return valid', () => {
    const result = validateSlug('a'.repeat(63))
    expect(result.valid).toBe(true)
  })

  test('given uppercase characters, should return invalid', () => {
    const result = validateSlug('MY_TENANT')
    expect(result.valid).toBe(false)
    expect(result.error).toBeDefined()
  })

  test('given underscores, should return invalid', () => {
    const result = validateSlug('my_tenant')
    expect(result.valid).toBe(false)
  })

  test('given a slug too short (1 char), should return invalid', () => {
    const result = validateSlug('a')
    expect(result.valid).toBe(false)
  })

  test('given a slug too short (2 chars), should return invalid', () => {
    const result = validateSlug('ab')
    expect(result.valid).toBe(false)
  })

  test('given a slug too long (64 chars), should return invalid', () => {
    const result = validateSlug('a'.repeat(64))
    expect(result.valid).toBe(false)
  })

  test('given a slug starting with a hyphen, should return invalid', () => {
    const result = validateSlug('-starts-bad')
    expect(result.valid).toBe(false)
  })

  test('given a slug ending with a hyphen, should return invalid', () => {
    const result = validateSlug('ends-bad-')
    expect(result.valid).toBe(false)
  })

  test('given consecutive hyphens, should return invalid', () => {
    const result = validateSlug('my--tenant')
    expect(result.valid).toBe(false)
  })

  test('given an empty string, should return invalid', () => {
    const result = validateSlug('')
    expect(result.valid).toBe(false)
  })

  test('given special characters, should return invalid', () => {
    const result = validateSlug('my.tenant')
    expect(result.valid).toBe(false)
  })

  // Reserved slug tests
  test('given "www" (reserved), should return invalid', () => {
    const result = validateSlug('www')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('reserved')
  })

  test('given "api" (reserved), should return invalid', () => {
    const result = validateSlug('api')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('reserved')
  })

  test('given "app" (reserved), should return invalid', () => {
    const result = validateSlug('app')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('reserved')
  })

  test('given "admin" (reserved), should return invalid', () => {
    const result = validateSlug('admin')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('reserved')
  })

  test('given "mail" (reserved), should return invalid', () => {
    const result = validateSlug('mail')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('reserved')
  })

  test('given "ftp" (reserved), should return invalid', () => {
    const result = validateSlug('ftp')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('reserved')
  })

  test('given "traefik" (reserved), should return invalid', () => {
    const result = validateSlug('traefik')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('reserved')
  })

  test('given "status" (reserved), should return invalid', () => {
    const result = validateSlug('status')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('reserved')
  })
})

describe('validateEmail', () => {
  test('given a valid email, should return valid', () => {
    const result = validateEmail('user@example.com')
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  test('given an email with subdomain, should return valid', () => {
    const result = validateEmail('user@mail.example.com')
    expect(result.valid).toBe(true)
  })

  test('given an email with plus addressing, should return valid', () => {
    const result = validateEmail('user+tag@example.com')
    expect(result.valid).toBe(true)
  })

  test('given a missing @ sign, should return invalid', () => {
    const result = validateEmail('userexample.com')
    expect(result.valid).toBe(false)
  })

  test('given a missing domain, should return invalid', () => {
    const result = validateEmail('user@')
    expect(result.valid).toBe(false)
  })

  test('given a missing local part, should return invalid', () => {
    const result = validateEmail('@example.com')
    expect(result.valid).toBe(false)
  })

  test('given an empty string, should return invalid', () => {
    const result = validateEmail('')
    expect(result.valid).toBe(false)
  })

  test('given no TLD, should return invalid', () => {
    const result = validateEmail('user@example')
    expect(result.valid).toBe(false)
  })

  test('given a ReDoS attack string, should complete in under 100ms', () => {
    // Trailing space forces regex failure, triggering polynomial backtracking
    // on vulnerable patterns where [^\s@] overlaps with literal '.'
    // At 10k repeats the vulnerable regex takes ~900ms; fixed regex takes <1ms
    const malicious = '!@' + '!.'.repeat(10000) + ' '
    const start = performance.now()
    const result = validateEmail(malicious)
    const elapsed = performance.now() - start
    expect(result.valid).toBe(false)
    expect(elapsed).toBeLessThan(100)
  })
})

describe('validateTier', () => {
  test('given "free", should return valid', () => {
    const result = validateTier('free')
    expect(result.valid).toBe(true)
  })

  test('given "pro", should return valid', () => {
    const result = validateTier('pro')
    expect(result.valid).toBe(true)
  })

  test('given "business", should return valid', () => {
    const result = validateTier('business')
    expect(result.valid).toBe(true)
  })

  test('given "enterprise", should return valid', () => {
    const result = validateTier('enterprise')
    expect(result.valid).toBe(true)
  })

  test('given an unknown tier, should return invalid', () => {
    const result = validateTier('premium')
    expect(result.valid).toBe(false)
    expect(result.error).toBeDefined()
  })

  test('given an empty string, should return invalid', () => {
    const result = validateTier('')
    expect(result.valid).toBe(false)
  })
})

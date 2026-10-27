import { describe, it, expect } from 'vitest'
import {
  normalizeSubdomain,
  validatePublishSubdomain,
  RESERVED_SUBDOMAINS,
} from '../subdomain'

describe('normalizeSubdomain', () => {
  it('given an uppercase input, should lowercase it', () => {
    expect(normalizeSubdomain('MyDrive')).toBe('mydrive')
  })

  it('given spaces, should replace them with hyphens', () => {
    expect(normalizeSubdomain('my cool drive')).toBe('my-cool-drive')
  })

  it('given surrounding whitespace, should trim it', () => {
    expect(normalizeSubdomain('  hello  ')).toBe('hello')
  })

  it('given junk characters, should strip them to hyphens and collapse', () => {
    expect(normalizeSubdomain('Hello!!!World')).toBe('hello-world')
  })

  it('given leading and trailing hyphens after normalization, should strip them', () => {
    expect(normalizeSubdomain('---abc---')).toBe('abc')
    expect(normalizeSubdomain('!!!abc!!!')).toBe('abc')
  })

  it('given consecutive separators, should collapse to a single hyphen', () => {
    expect(normalizeSubdomain('a   b___c')).toBe('a-b-c')
  })
})

describe('validatePublishSubdomain', () => {
  it('given a valid simple subdomain, should be valid', () => {
    expect(validatePublishSubdomain('mydrive')).toEqual({ valid: true })
  })

  it('given a valid subdomain with internal hyphens, should be valid', () => {
    expect(validatePublishSubdomain('my-cool-drive')).toEqual({ valid: true })
  })

  it('given a valid alphanumeric subdomain, should be valid', () => {
    expect(validatePublishSubdomain('drive123')).toEqual({ valid: true })
  })

  it('given a single character, should be valid', () => {
    expect(validatePublishSubdomain('a')).toEqual({ valid: true })
  })

  it('given a subdomain at exactly 63 characters, should be valid', () => {
    const input = 'a'.repeat(63)
    expect(input.length).toBe(63)
    expect(validatePublishSubdomain(input)).toEqual({ valid: true })
  })

  it('given an empty string, should be invalid', () => {
    const result = validatePublishSubdomain('')
    expect(result.valid).toBe(false)
  })

  it('given a string that normalizes to empty, should be invalid', () => {
    const result = validatePublishSubdomain('!!!')
    expect(result.valid).toBe(false)
  })

  it('given a normalized subdomain longer than 63 characters, should be invalid', () => {
    const input = 'a'.repeat(64)
    const result = validatePublishSubdomain(input)
    expect(result.valid).toBe(false)
  })

  it('given underscores, should normalize and pass', () => {
    expect(validatePublishSubdomain('my_drive')).toEqual({ valid: true })
  })

  it.each(['www', 'api', 'admin', 'app', 'pagespace', 'mail', '_psl', 'ns1'])(
    'given reserved name "%s", should be invalid',
    (name) => {
      const result = validatePublishSubdomain(name)
      expect(result.valid).toBe(false)
    }
  )

  it('given every reserved name, should be invalid', () => {
    for (const name of RESERVED_SUBDOMAINS) {
      const result = validatePublishSubdomain(name)
      expect(result.valid).toBe(false)
    }
  })

  it('given a name whose normalized form is reserved, should be invalid', () => {
    const result = validatePublishSubdomain('WWW')
    expect(result.valid).toBe(false)
  })

  it('given a normalized leading/trailing hyphen input, should still pass after stripping', () => {
    // Normalization strips the hyphens, so this is a valid subdomain.
    expect(validatePublishSubdomain('-abc-')).toEqual({ valid: true })
  })
})

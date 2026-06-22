import { describe, it, expect } from 'vitest'
import {
  resolveUniquePublishSubdomain,
  MAX_SUBDOMAIN_LENGTH,
} from '../subdomain'

describe('resolveUniquePublishSubdomain', () => {
  it('given a free base, should return the base unchanged', () => {
    expect(resolveUniquePublishSubdomain('acme', [])).toBe('acme')
  })

  it('given a taken base, should append a -2 suffix', () => {
    expect(resolveUniquePublishSubdomain('acme', ['acme'])).toBe('acme-2')
  })

  it('given a base taken with the -2 suffix too, should append -3', () => {
    expect(resolveUniquePublishSubdomain('acme', ['acme', 'acme-2'])).toBe('acme-3')
  })

  it('given two owners each naming a drive acme, should allocate distinct unique subdomains', () => {
    // First owner gets the base; the second must not collide.
    const first = resolveUniquePublishSubdomain('acme', [])
    const second = resolveUniquePublishSubdomain('acme', [first])
    expect(first).not.toBe(second)
    expect(second).toBe('acme-2')
  })

  it('given a base that normalizes to a reserved name, should allocate a non-reserved suffix', () => {
    // 'blog' is reserved → the first usable candidate is 'blog-2'.
    const result = resolveUniquePublishSubdomain('blog', [])
    expect(result).toBe('blog-2')
  })

  it('given a base that is already reserved AND suffixed, should skip to the next free', () => {
    // 'blog' reserved, 'blog-2' taken → 'blog-3'.
    expect(resolveUniquePublishSubdomain('blog', ['blog-2'])).toBe('blog-3')
  })

  it('given an empty/normalized-empty base, should fall back to a non-empty safe default', () => {
    const result = resolveUniquePublishSubdomain('!!!', [])
    expect(result.length).toBeGreaterThan(0)
    expect(validateShape(result)).toBe(true)
  })

  it('given a 63-char base that is itself taken, should truncate + suffix to fit', () => {
    // A 63-char base is a valid label. When the base itself is taken, the allocator
    // must truncate to leave suffix headroom so the next candidate stays ≤ 63.
    const longBase = 'a'.repeat(MAX_SUBDOMAIN_LENGTH) // exactly 63
    const result = resolveUniquePublishSubdomain(longBase, [longBase])
    expect(result.length).toBeLessThanOrEqual(MAX_SUBDOMAIN_LENGTH)
    expect(result.endsWith('-2')).toBe(true)
    expect(validateShape(result)).toBe(true)
  })

  it('given a taken set with a gap, should fill the lowest free suffix', () => {
    expect(resolveUniquePublishSubdomain('acme', ['acme', 'acme-2', 'acme-4'])).toBe('acme-3')
  })

  it('given the result for any input/taken combination, should always be valid + not in the taken set', () => {
    const cases: Array<[string, string[]]> = [
      ['My Drive', []],
      ['www', []],
      ['acme', ['acme', 'acme-2', 'acme-3']],
      ['a'.repeat(80), ['a'.repeat(63)]],
    ]
    for (const [base, taken] of cases) {
      const result = resolveUniquePublishSubdomain(base, taken)
      expect(validateShape(result)).toBe(true)
      expect(taken).not.toContain(result)
      expect(result.length).toBeLessThanOrEqual(MAX_SUBDOMAIN_LENGTH)
    }
  })

  it('given more than 99 collisions, should not infinite-loop and should return a valid <=63 candidate', () => {
    // Regression: a static -NN clamp headroom caused an infinite loop once the
    // suffix hit 3 digits (candidate exceeded 63 chars and never validated).
    const base = 'acme'
    const taken: string[] = []
    for (let i = 2; i <= 150; i++) taken.push(`acme-${i}`)
    const result = resolveUniquePublishSubdomain(base, taken)
    expect(result.length).toBeLessThanOrEqual(MAX_SUBDOMAIN_LENGTH)
    expect(validateShape(result)).toBe(true)
    expect(taken).not.toContain(result)
  })

  it('given a long base with many collisions, should truncate the base per suffix to stay within 63 chars', () => {
    // Worst case that previously infinite-looped: a 63-char base clamps to 60,
    // the bare 60-char form is taken, AND 60-char-2..-120 are all taken. The
    // per-suffix clamp must keep truncating so candidates stay ≤ 63 and validate.
    const longBase = 'b'.repeat(63)
    const clamped60 = 'b'.repeat(60)
    const taken: string[] = [longBase, clamped60]
    for (let i = 2; i <= 120; i++) taken.push(`${clamped60}-${i}`)
    const result = resolveUniquePublishSubdomain(longBase, taken)
    expect(result.length).toBeLessThanOrEqual(MAX_SUBDOMAIN_LENGTH)
    expect(validateShape(result)).toBe(true)
    expect(taken).not.toContain(result)
  })
})

/** Shape check mirroring SUBDOMAIN_PATTERN: lowercase, no leading/trailing hyphen. */
function validateShape(s: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s)
}

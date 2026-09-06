import { describe, it, expect, vi } from 'vitest'
import {
  allocateUniqueSubdomainWithRetry,
  isUniqueViolation,
  subdomainCollisionPrefix,
  SUBDOMAIN_COLLISION_PREFIX_LENGTH,
} from '../subdomain-allocation'
import { resolveUniquePublishSubdomain } from '../../validators/subdomain'

describe('allocateUniqueSubdomainWithRetry', () => {
  it('given a free candidate on the first attempt, should return it without retrying', async () => {
    const fetchTaken = vi.fn().mockResolvedValue([])
    const attempt = vi.fn().mockResolvedValue(undefined)
    const result = await allocateUniqueSubdomainWithRetry({
      base: 'acme',
      fetchTaken,
      attempt,
    })
    expect(result).toBe('acme')
    expect(fetchTaken).toHaveBeenCalledTimes(1)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(attempt).toHaveBeenCalledWith('acme')
  })

  it('given a unique-violation on the first attempt, should re-fetch taken + retry with a new candidate', async () => {
    const fetchTaken = vi
      .fn()
      // first call: the DB said 'acme' was free when we read it, but the insert races
      .mockResolvedValueOnce([])
      // second call: now 'acme' is present
      .mockResolvedValueOnce(['acme'])
    const uniqueViolation = Object.assign(new Error('unique'), { code: '23505' })
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(uniqueViolation)
      .mockResolvedValueOnce(undefined)
    const result = await allocateUniqueSubdomainWithRetry({
      base: 'acme',
      fetchTaken,
      attempt,
    })
    expect(result).toBe('acme-2')
    expect(fetchTaken).toHaveBeenCalledTimes(2)
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(attempt).toHaveBeenNthCalledWith(2, 'acme-2')
  })

  it('given repeated unique-violations, should retry up to the limit then give up', async () => {
    const fetchTaken = vi.fn().mockResolvedValue([])
    const uniqueViolation = Object.assign(new Error('unique'), { code: '23505' })
    const attempt = vi.fn().mockRejectedValue(uniqueViolation)
    await expect(
      allocateUniqueSubdomainWithRetry({
        base: 'acme',
        fetchTaken,
        attempt,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/unique/i)
    expect(fetchTaken).toHaveBeenCalledTimes(3)
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('given a non-unique error, should rethrow immediately without retry', async () => {
    const fetchTaken = vi.fn().mockResolvedValue([])
    const attempt = vi.fn().mockRejectedValue(new Error('connection refused'))
    await expect(
      allocateUniqueSubdomainWithRetry({ base: 'acme', fetchTaken, attempt })
    ).rejects.toThrow('connection refused')
    expect(fetchTaken).toHaveBeenCalledTimes(1)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('given attempt returns a different value (e.g. a race-winner actual), should return that value, not the computed candidate', async () => {
    // Race: we computed 'acme-2', but a concurrent writer set 'acme' and the
    // conditional update affected 0 rows; attempt re-reads and returns the ACTUAL
    // persisted value. The wrapper must honor attempt's return over its own candidate.
    const fetchTaken = vi.fn().mockResolvedValue(['acme'])
    const attempt = vi.fn().mockResolvedValue('acme') // the real persisted value
    const result = await allocateUniqueSubdomainWithRetry({ base: 'acme', fetchTaken, attempt })
    expect(result).toBe('acme') // NOT 'acme-2'
    expect(attempt).toHaveBeenCalledWith('acme-2')
  })
})

describe('subdomainCollisionPrefix', () => {
  it('given a short base, should return the whole normalized base', () => {
    expect(subdomainCollisionPrefix('Acme')).toBe('acme')
  })

  it('given an empty/reserved-only base, should fall back the same way the allocator does', () => {
    expect(subdomainCollisionPrefix('!!!')).toBe('drive')
  })

  it('given a base longer than the prefix length, should truncate to SUBDOMAIN_COLLISION_PREFIX_LENGTH', () => {
    const longBase = 'a'.repeat(SUBDOMAIN_COLLISION_PREFIX_LENGTH + 20)
    const prefix = subdomainCollisionPrefix(longBase)
    expect(prefix).toHaveLength(SUBDOMAIN_COLLISION_PREFIX_LENGTH)
    expect(prefix).toBe('a'.repeat(SUBDOMAIN_COLLISION_PREFIX_LENGTH))
  })

  it('never hides a real collision: every candidate the allocator could produce starts with the prefix, for many suffixes', () => {
    // Mutation-style correctness check: simulate a long run of collisions and
    // confirm every candidate the PURE allocator core actually proposes still
    // starts with the prefix a `fetchTaken` query would filter on — i.e. the
    // bounded query could never have excluded a row that matters.
    const base = 'my-published-app-environment-name'
    const prefix = subdomainCollisionPrefix(base)
    const taken: string[] = []
    for (let i = 0; i < 50; i += 1) {
      const candidate = resolveUniquePublishSubdomain(base, taken)
      expect(candidate.startsWith(prefix)).toBe(true)
      taken.push(candidate)
    }
  })
})

describe('isUniqueViolation', () => {
  it('given a raw PG error with code 23505, should return true', () => {
    const err = Object.assign(new Error('unique'), { code: '23505' })
    expect(isUniqueViolation(err)).toBe(true)
  })

  it('given a non-23505 error, should return false', () => {
    const err = Object.assign(new Error('fk'), { code: '23503' })
    expect(isUniqueViolation(err)).toBe(false)
  })

  it('given a Drizzle-wrapped error whose .cause has code 23505, should return true', () => {
    // Drizzle wraps the underlying driver error in .cause — a top-level-only check
    // would miss this and wrongly rethrow instead of retrying.
    const cause = Object.assign(new Error('unique'), { code: '23505' })
    const wrapped = Object.assign(new Error('drizzle'), { cause })
    expect(isUniqueViolation(wrapped)).toBe(true)
  })

  it('given a deeply-wrapped error, should find the 23505 in the cause chain', () => {
    const inner = Object.assign(new Error('unique'), { code: '23505' })
    const mid = Object.assign(new Error('mid'), { cause: inner })
    const outer = Object.assign(new Error('outer'), { cause: mid })
    expect(isUniqueViolation(outer)).toBe(true)
  })

  it('given a wrapped error whose cause is NOT 23505, should return false', () => {
    const cause = Object.assign(new Error('fk'), { code: '23503' })
    const wrapped = Object.assign(new Error('drizzle'), { cause })
    expect(isUniqueViolation(wrapped)).toBe(false)
  })
})

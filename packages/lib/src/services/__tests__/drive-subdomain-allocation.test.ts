import { describe, it, expect, vi } from 'vitest'
import { allocateUniqueSubdomainWithRetry } from '../subdomain-allocation'

describe('allocateUniqueSubdomainWithRetry', () => {
  it('given a free candidate on the first attempt, should return it without retrying', async () => {
    const fetchTaken = vi.fn().mockResolvedValue([])
    const attempt = vi.fn().mockResolvedValue('ok')
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
      .mockResolvedValueOnce('ok')
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
})

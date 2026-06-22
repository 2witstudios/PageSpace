import { describe, it, expect } from 'vitest'
import { computePublishSubdomainBackfill } from '../lib/publish-subdomain-backfill'

describe('computePublishSubdomainBackfill', () => {
  it('given a single missing drive, should allocate its slug-derived subdomain', () => {
    const result = computePublishSubdomainBackfill(
      [{ id: 'd1', slug: 'acme', publishSubdomain: null }],
      [],
    )
    expect(result).toEqual([{ driveId: 'd1', subdomain: 'acme' }])
  })

  it('given a drive whose slug is already taken, should append a suffix', () => {
    const result = computePublishSubdomainBackfill(
      [{ id: 'd1', slug: 'acme', publishSubdomain: null }],
      ['acme'],
    )
    expect(result).toEqual([{ driveId: 'd1', subdomain: 'acme-2' }])
  })

  it('given multiple missing drives with the same slug, should give each a distinct subdomain', () => {
    const result = computePublishSubdomainBackfill(
      [
        { id: 'd1', slug: 'acme', publishSubdomain: null },
        { id: 'd2', slug: 'acme', publishSubdomain: null },
        { id: 'd3', slug: 'acme', publishSubdomain: null },
      ],
      [],
    )
    const subdomains = result.map((r) => r.subdomain)
    expect(subdomains).toEqual(['acme', 'acme-2', 'acme-3'])
    expect(new Set(subdomains).size).toBe(3) // all distinct
  })

  it('given a drive that already has a publishSubdomain, should skip it', () => {
    const result = computePublishSubdomainBackfill(
      [
        { id: 'd1', slug: 'acme', publishSubdomain: 'already-set' },
        { id: 'd2', slug: 'beta', publishSubdomain: null },
      ],
      ['already-set'],
    )
    expect(result).toEqual([{ driveId: 'd2', subdomain: 'beta' }])
  })

  it('given a missing drive with no missing drives, should return an empty array', () => {
    expect(computePublishSubdomainBackfill([], ['acme'])).toEqual([])
  })

  it('given a drive whose slug is reserved, should skip to a non-reserved suffix', () => {
    const result = computePublishSubdomainBackfill(
      [{ id: 'd1', slug: 'blog', publishSubdomain: null }],
      [],
    )
    expect(result[0].subdomain).toBe('blog-2')
  })

  it('given the union of taken + within-run allocations, should never collide', () => {
    const result = computePublishSubdomainBackfill(
      [
        { id: 'd1', slug: 'acme', publishSubdomain: null },
        { id: 'd2', slug: 'acme', publishSubdomain: null },
        { id: 'd3', slug: 'www', publishSubdomain: null },
        { id: 'd4', slug: 'acme-2', publishSubdomain: null },
      ],
      ['acme', 'acme-2'],
    )
    const subdomains = result.map((r) => r.subdomain)
    // 'acme' and 'acme-2' already taken → d1 gets acme-3; d2 (acme) → acme-4;
    // d3 ('www' reserved) → www-2; d4 ('acme-2') → acme-5
    expect(new Set(subdomains).size).toBe(subdomains.length)
    expect(subdomains).not.toContain('acme')
    expect(subdomains).not.toContain('acme-2')
    expect(subdomains).not.toContain('www')
  })
})

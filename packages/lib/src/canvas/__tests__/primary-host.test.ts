import { describe, it, expect } from 'vitest';
import { resolvePrimaryPublishedHost } from '../primary-host';

describe('resolvePrimaryPublishedHost', () => {
  const PUBLISH_HOST = 'pagespace.site';

  it('returns the subdomain fallback when there are no active domains', () => {
    const host = resolvePrimaryPublishedHost({
      subdomain: 'acme',
      publishHost: PUBLISH_HOST,
      activeDomains: [],
    });
    expect(host).toBe('acme.pagespace.site');
  });

  it('returns the single active domain hostname when only one exists', () => {
    const host = resolvePrimaryPublishedHost({
      subdomain: 'acme',
      publishHost: PUBLISH_HOST,
      activeDomains: [{ hostname: 'www.acme.com', createdAt: new Date('2026-01-01T00:00:00.000Z') }],
    });
    expect(host).toBe('www.acme.com');
  });

  it('picks the earliest createdAt domain when multiple are active', () => {
    const host = resolvePrimaryPublishedHost({
      subdomain: 'acme',
      publishHost: PUBLISH_HOST,
      activeDomains: [
        { hostname: 'docs.acme.com', createdAt: new Date('2026-03-01T00:00:00.000Z') },
        { hostname: 'www.acme.com',  createdAt: new Date('2026-01-01T00:00:00.000Z') },
        { hostname: 'blog.acme.com', createdAt: new Date('2026-06-01T00:00:00.000Z') },
      ],
    });
    expect(host).toBe('www.acme.com');
  });

  it('breaks createdAt ties by hostname lexicographic order (deterministic)', () => {
    const sameTime = new Date('2026-01-01T00:00:00.000Z');
    const host = resolvePrimaryPublishedHost({
      subdomain: 'acme',
      publishHost: PUBLISH_HOST,
      activeDomains: [
        { hostname: 'z.acme.com', createdAt: sameTime },
        { hostname: 'a.acme.com', createdAt: sameTime },
        { hostname: 'm.acme.com', createdAt: sameTime },
      ],
    });
    expect(host).toBe('a.acme.com');
  });

  it('does not mutate the input array when sorting', () => {
    const input = [
      { hostname: 'b.acme.com', createdAt: new Date('2026-01-02T00:00:00.000Z') },
      { hostname: 'a.acme.com', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ];
    const originalOrder = input.map((d) => d.hostname);

    resolvePrimaryPublishedHost({ subdomain: 'acme', publishHost: PUBLISH_HOST, activeDomains: input });

    expect(input.map((d) => d.hostname)).toEqual(originalOrder);
  });

  it('is deterministic: same inputs always yield the same output', () => {
    const domains = [
      { hostname: 'c.example.com', createdAt: new Date('2026-02-01T00:00:00.000Z') },
      { hostname: 'a.example.com', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ];
    const first  = resolvePrimaryPublishedHost({ subdomain: 's', publishHost: PUBLISH_HOST, activeDomains: domains });
    const second = resolvePrimaryPublishedHost({ subdomain: 's', publishHost: PUBLISH_HOST, activeDomains: domains });
    expect(first).toBe(second);
    expect(first).toBe('a.example.com');
  });

  it('prefers the custom domain over the subdomain fallback regardless of subdomain value', () => {
    const host = resolvePrimaryPublishedHost({
      subdomain: 'my-drive',
      publishHost: PUBLISH_HOST,
      activeDomains: [{ hostname: 'custom.example.com', createdAt: new Date('2026-06-01T00:00:00.000Z') }],
    });
    expect(host).not.toBe('my-drive.pagespace.site');
    expect(host).toBe('custom.example.com');
  });

  it('honors an explicitly-selected primary over the earliest-created default', () => {
    const host = resolvePrimaryPublishedHost({
      subdomain: 'acme',
      publishHost: PUBLISH_HOST,
      activeDomains: [
        { hostname: 'www.acme.com',  createdAt: new Date('2026-01-01T00:00:00.000Z') },
        { hostname: 'docs.acme.com', createdAt: new Date('2026-03-01T00:00:00.000Z'), isPrimary: true },
        { hostname: 'blog.acme.com', createdAt: new Date('2026-06-01T00:00:00.000Z') },
      ],
    });
    expect(host).toBe('docs.acme.com');
  });

  it('falls back to earliest-created when isPrimary is false on every domain', () => {
    const host = resolvePrimaryPublishedHost({
      subdomain: 'acme',
      publishHost: PUBLISH_HOST,
      activeDomains: [
        { hostname: 'docs.acme.com', createdAt: new Date('2026-03-01T00:00:00.000Z'), isPrimary: false },
        { hostname: 'www.acme.com',  createdAt: new Date('2026-01-01T00:00:00.000Z'), isPrimary: false },
      ],
    });
    expect(host).toBe('www.acme.com');
  });

  it('breaks ties between multiple flagged primaries deterministically', () => {
    const sameTime = new Date('2026-01-01T00:00:00.000Z');
    const host = resolvePrimaryPublishedHost({
      subdomain: 'acme',
      publishHost: PUBLISH_HOST,
      activeDomains: [
        { hostname: 'z.acme.com', createdAt: sameTime, isPrimary: true },
        { hostname: 'a.acme.com', createdAt: sameTime, isPrimary: true },
      ],
    });
    expect(host).toBe('a.acme.com');
  });
});

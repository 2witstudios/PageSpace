import { describe, it, expect } from 'vitest';
import { planCustomDomainMirror } from '../custom-domain-mirror';

describe('planCustomDomainMirror', () => {
  it('zero active hosts → empty copy set (no-op)', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: ['about', 'team'],
      hosts: [],
    });

    expect(copies).toHaveLength(0);
  });

  it('zero active hosts with includeRoot and include404 → still empty (no-op)', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: ['about'],
      hosts: [],
      includeRoot: true,
      include404: true,
    });

    expect(copies).toHaveLength(0);
  });

  it('N paths × 1 host → N copy ops with correct keys', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: ['about', 'team'],
      hosts: ['www.example.com'],
    });

    expect(copies).toHaveLength(2);
    expect(copies).toContainEqual({
      from: 'published/acme/about/index.html',
      to: 'published/www.example.com/about/index.html',
    });
    expect(copies).toContainEqual({
      from: 'published/acme/team/index.html',
      to: 'published/www.example.com/team/index.html',
    });
  });

  it('N paths × M hosts → N×M copy ops', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: ['about', 'team'],
      hosts: ['www.example.com', 'docs.example.com'],
    });

    expect(copies).toHaveLength(4);
    // Both hosts receive both paths
    expect(copies.filter((c) => c.to.startsWith('published/www.example.com/'))).toHaveLength(2);
    expect(copies.filter((c) => c.to.startsWith('published/docs.example.com/'))).toHaveLength(2);
  });

  it('includeRoot adds root mirror for each host (empty path → index.html at prefix root)', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: ['home'],
      hosts: ['www.example.com'],
      includeRoot: true,
    });

    // 1 page path + 1 root = 2
    expect(copies).toHaveLength(2);
    expect(copies).toContainEqual({
      from: 'published/acme/index.html',
      to: 'published/www.example.com/index.html',
    });
  });

  it('includeRoot with zero paths → only the root copy', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: [],
      hosts: ['www.example.com'],
      includeRoot: true,
    });

    expect(copies).toHaveLength(1);
    expect(copies[0]).toEqual({
      from: 'published/acme/index.html',
      to: 'published/www.example.com/index.html',
    });
  });

  it('include404 adds 404.html for each host', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: [],
      hosts: ['www.example.com'],
      include404: true,
    });

    expect(copies).toHaveLength(1);
    expect(copies[0]).toEqual({
      from: 'published/acme/404.html',
      to: 'published/www.example.com/404.html',
    });
  });

  it('include404 × M hosts → M copies of 404.html', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: [],
      hosts: ['a.example.com', 'b.example.com'],
      include404: true,
    });

    expect(copies).toHaveLength(2);
    expect(copies).toContainEqual({
      from: 'published/acme/404.html',
      to: 'published/a.example.com/404.html',
    });
    expect(copies).toContainEqual({
      from: 'published/acme/404.html',
      to: 'published/b.example.com/404.html',
    });
  });

  it('includeRoot + include404 + N paths × M hosts → correct total count', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: ['about', 'team'],
      hosts: ['a.example.com', 'b.example.com'],
      includeRoot: true,
      include404: true,
    });

    // (2 paths + 1 root + 1 404) × 2 hosts = 8
    expect(copies).toHaveLength(8);
  });

  it('includeSiteFiles adds robots.txt and sitemap.xml for each host', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: [],
      hosts: ['www.example.com'],
      includeSiteFiles: true,
    });

    expect(copies).toHaveLength(2);
    expect(copies).toContainEqual({
      from: 'published/acme/robots.txt',
      to: 'published/www.example.com/robots.txt',
    });
    expect(copies).toContainEqual({
      from: 'published/acme/sitemap.xml',
      to: 'published/www.example.com/sitemap.xml',
    });
  });

  it('includeSiteFiles × M hosts → 2×M copies', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: [],
      hosts: ['a.example.com', 'b.example.com'],
      includeSiteFiles: true,
    });

    // 2 site files × 2 hosts = 4
    expect(copies).toHaveLength(4);
  });

  it('includeSiteFiles does NOT include 404.html (that is include404)', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: [],
      hosts: ['www.example.com'],
      includeSiteFiles: true,
    });

    const tos = copies.map((c) => c.to);
    expect(tos).not.toContain('published/www.example.com/404.html');
  });

  it('includeRoot + include404 + includeSiteFiles + N paths × M hosts → correct total', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: ['about', 'team'],
      hosts: ['a.example.com', 'b.example.com'],
      includeRoot: true,
      include404: true,
      includeSiteFiles: true,
    });

    // (2 paths + 1 root + 1 404 + 2 site files) × 2 hosts = 12
    expect(copies).toHaveLength(12);
  });

  it('does not include site files by default', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: ['about'],
      hosts: ['www.example.com'],
    });

    const tos = copies.map((c) => c.to);
    expect(tos).not.toContain('published/www.example.com/robots.txt');
    expect(tos).not.toContain('published/www.example.com/sitemap.xml');
  });

  it('page key uses subdomain as source prefix verbatim', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'my-drive',
      paths: ['about'],
      hosts: ['custom.host'],
    });

    expect(copies[0].from).toBe('published/my-drive/about/index.html');
    expect(copies[0].to).toBe('published/custom.host/about/index.html');
  });

  it('does not include root or 404 by default', () => {
    const { copies } = planCustomDomainMirror({
      subdomain: 'acme',
      paths: ['about'],
      hosts: ['www.example.com'],
    });

    const keys = copies.map((c) => c.to);
    expect(keys).not.toContain('published/www.example.com/index.html');
    expect(keys).not.toContain('published/www.example.com/404.html');
  });
});

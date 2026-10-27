import { describe, it, expect } from 'vitest';
import {
  planCustomDomainMirror,
  resolveHostRootCopies,
  resolveBackfillRootCopy,
} from '../custom-domain-mirror';

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

describe('resolveHostRootCopies', () => {
  it('a host with no override gets the root copy when the publish IS the drive home page', () => {
    const copies = resolveHostRootCopies({
      subdomain: 'acme',
      pageId: 'page-home',
      path: 'home',
      homePageId: 'page-home',
      hosts: [{ hostname: 'www.example.com', publishLandingPageId: null }],
    });

    expect(copies).toEqual([
      { from: 'published/acme/home/index.html', to: 'published/www.example.com/index.html' },
    ]);
  });

  it('a host with no override is skipped when the publish is NOT the drive home page', () => {
    const copies = resolveHostRootCopies({
      subdomain: 'acme',
      pageId: 'page-about',
      path: 'about',
      homePageId: 'page-home',
      hosts: [{ hostname: 'www.example.com', publishLandingPageId: null }],
    });

    expect(copies).toHaveLength(0);
  });

  it('a host with an override gets the root copy only when the publish IS its override page', () => {
    const copies = resolveHostRootCopies({
      subdomain: 'acme',
      pageId: 'page-docs-index',
      path: 'docs',
      homePageId: 'page-home',
      hosts: [{ hostname: 'docs.example.com', publishLandingPageId: 'page-docs-index' }],
    });

    expect(copies).toEqual([
      { from: 'published/acme/docs/index.html', to: 'published/docs.example.com/index.html' },
    ]);
  });

  it('publishing the drive home page must NOT touch a host overridden to a different page', () => {
    const copies = resolveHostRootCopies({
      subdomain: 'acme',
      pageId: 'page-home',
      path: 'home',
      homePageId: 'page-home',
      hosts: [{ hostname: 'docs.example.com', publishLandingPageId: 'page-docs-index' }],
    });

    expect(copies).toHaveLength(0);
  });

  it('mixed hosts: default-following and overridden hosts resolve independently in one call', () => {
    const copies = resolveHostRootCopies({
      subdomain: 'acme',
      pageId: 'page-home',
      path: 'home',
      homePageId: 'page-home',
      hosts: [
        { hostname: 'www.example.com', publishLandingPageId: null },
        { hostname: 'docs.example.com', publishLandingPageId: 'page-docs-index' },
      ],
    });

    expect(copies).toEqual([
      { from: 'published/acme/home/index.html', to: 'published/www.example.com/index.html' },
    ]);
  });
});

describe('resolveBackfillRootCopy', () => {
  it('override set + override page published → copies from the override page\'s own path', () => {
    const copy = resolveBackfillRootCopy({
      subdomain: 'acme',
      host: 'docs.example.com',
      publishLandingPageId: 'page-docs-index',
      homePageId: 'page-home',
      homeRootExists: true,
      published: [
        { pageId: 'page-home', path: 'home' },
        { pageId: 'page-docs-index', path: 'docs' },
      ],
    });

    expect(copy).toEqual({
      from: 'published/acme/docs/index.html',
      to: 'published/docs.example.com/index.html',
    });
  });

  it('override set but override page not yet published → null (nothing to copy)', () => {
    const copy = resolveBackfillRootCopy({
      subdomain: 'acme',
      host: 'docs.example.com',
      publishLandingPageId: 'page-docs-index',
      homePageId: 'page-home',
      homeRootExists: true,
      published: [{ pageId: 'page-home', path: 'home' }],
    });

    expect(copy).toBeNull();
  });

  it('no override + home root exists → falls back to the drive-wide root object', () => {
    const copy = resolveBackfillRootCopy({
      subdomain: 'acme',
      host: 'www.example.com',
      publishLandingPageId: null,
      homePageId: 'page-home',
      homeRootExists: true,
      published: [{ pageId: 'page-home', path: 'home' }],
    });

    expect(copy).toEqual({
      from: 'published/acme/index.html',
      to: 'published/www.example.com/index.html',
    });
  });

  it('no override + home root does not exist yet → null', () => {
    const copy = resolveBackfillRootCopy({
      subdomain: 'acme',
      host: 'www.example.com',
      publishLandingPageId: null,
      homePageId: 'page-home',
      homeRootExists: false,
      published: [{ pageId: 'page-home', path: 'home' }],
    });

    expect(copy).toBeNull();
  });

  it('no override + no home page set → null', () => {
    const copy = resolveBackfillRootCopy({
      subdomain: 'acme',
      host: 'www.example.com',
      publishLandingPageId: null,
      homePageId: null,
      homeRootExists: false,
      published: [],
    });

    expect(copy).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { buildRobotsTxt, buildSitemapXml, buildNotFoundHtml } from '../site-files';

describe('buildRobotsTxt', () => {
  it('given a sitemap URL, allows all crawling and references the sitemap', () => {
    const txt = buildRobotsTxt({ sitemapUrl: 'https://acme.pagespace.site/sitemap.xml' });

    expect(txt).toContain('User-agent: *');
    expect(txt).toContain('Allow: /');
    expect(txt).toContain('Sitemap: https://acme.pagespace.site/sitemap.xml');
  });

  it('ends with a trailing newline so the file is well-formed', () => {
    const txt = buildRobotsTxt({ sitemapUrl: 'https://acme.pagespace.site/sitemap.xml' });
    expect(txt.endsWith('\n')).toBe(true);
  });
});

describe('buildSitemapXml', () => {
  it('given routes, emits the sitemaps.org urlset with one <url> per route', () => {
    const xml = buildSitemapXml([
      { loc: 'https://acme.pagespace.site/' },
      { loc: 'https://acme.pagespace.site/about' },
    ]);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://acme.pagespace.site/</loc>');
    expect(xml).toContain('<loc>https://acme.pagespace.site/about</loc>');
    expect((xml.match(/<url>/g) ?? []).length).toBe(2);
    expect(xml).toContain('</urlset>');
  });

  it('emits <lastmod> only when provided', () => {
    const xml = buildSitemapXml([
      { loc: 'https://acme.pagespace.site/a', lastmod: '2026-06-22T00:00:00.000Z' },
      { loc: 'https://acme.pagespace.site/b' },
    ]);

    expect(xml).toContain('<lastmod>2026-06-22T00:00:00.000Z</lastmod>');
    expect((xml.match(/<lastmod>/g) ?? []).length).toBe(1);
  });

  it('orders entries deterministically by loc regardless of input order', () => {
    const xml = buildSitemapXml([
      { loc: 'https://acme.pagespace.site/zebra' },
      { loc: 'https://acme.pagespace.site/apple' },
      { loc: 'https://acme.pagespace.site/mango' },
    ]);

    const appleIdx = xml.indexOf('/apple');
    const mangoIdx = xml.indexOf('/mango');
    const zebraIdx = xml.indexOf('/zebra');
    expect(appleIdx).toBeLessThan(mangoIdx);
    expect(mangoIdx).toBeLessThan(zebraIdx);
  });

  it('is deterministic — same routes in any order produce identical output', () => {
    const a = buildSitemapXml([{ loc: 'https://x/2' }, { loc: 'https://x/1' }]);
    const b = buildSitemapXml([{ loc: 'https://x/1' }, { loc: 'https://x/2' }]);
    expect(a).toBe(b);
  });

  it('XML-escapes special characters in loc so the document stays well-formed', () => {
    const xml = buildSitemapXml([{ loc: 'https://acme.pagespace.site/search?q=a&b<c>' }]);

    expect(xml).toContain('<loc>https://acme.pagespace.site/search?q=a&amp;b&lt;c&gt;</loc>');
    expect(xml).not.toContain('q=a&b<c>');
  });

  it('given no routes, still emits a valid empty urlset', () => {
    const xml = buildSitemapXml([]);

    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('</urlset>');
    expect((xml.match(/<url>/g) ?? []).length).toBe(0);
  });
});

describe('buildNotFoundHtml', () => {
  it('renders a standalone branded 404 document', () => {
    const html = buildNotFoundHtml({ siteName: 'Acme' });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('404');
    expect(html).toContain('Page not found');
    expect(html).toContain('Acme');
    expect(html).toContain('PageSpace');
    // No external stylesheet — styles are inline so it renders on a bare storage hit.
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  it('marks itself noindex so error pages never enter the crawl index', () => {
    const html = buildNotFoundHtml({ siteName: 'Acme' });
    expect(html).toContain('name="robots" content="noindex"');
  });

  it('falls back to a generic name when none is given', () => {
    expect(buildNotFoundHtml().toLowerCase()).toContain('this site');
    expect(buildNotFoundHtml({ siteName: '   ' }).toLowerCase()).toContain('this site');
  });

  it('escapes the site name so it cannot inject markup', () => {
    const html = buildNotFoundHtml({ siteName: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

import { describe, it, expect } from 'vitest';
import { buildPreviewResponseHeaders } from '../preview-headers';
import { buildSiteCsp, buildBaselineCsp } from '../csp';

describe('buildPreviewResponseHeaders', () => {
  it('given a blank policy, should return null so the route refuses rather than serving an unpoliced frame', () => {
    expect(buildPreviewResponseHeaders('')).toBeNull();
  });

  it('given a whitespace-only policy, should also return null', () => {
    expect(buildPreviewResponseHeaders('   \n ')).toBeNull();
  });

  it("given a policy, should append frame-ancestors 'self' so only the dashboard can frame it", () => {
    const headers = buildPreviewResponseHeaders(buildSiteCsp());
    expect(headers?.['Content-Security-Policy']).toContain("frame-ancestors 'self'");
  });

  it('given a policy with a trailing semicolon, should not emit an empty directive', () => {
    const headers = buildPreviewResponseHeaders("default-src 'none';");
    expect(headers?.['Content-Security-Policy']).toBe("default-src 'none'; frame-ancestors 'self'");
  });

  it('given the site policy, should preserve its fetch directives byte-for-byte so preview matches production', () => {
    const site = buildSiteCsp();
    const emitted = buildPreviewResponseHeaders(site)!['Content-Security-Policy'];
    // Everything the published artifact carries must survive verbatim; only the
    // embedding directive may differ, since published is a top-level document.
    expect(emitted.startsWith(site)).toBe(true);
    for (const directive of site.split(';').map((d) => d.trim())) {
      expect(emitted).toContain(directive);
    }
  });

  it('given the baseline policy, should work identically for a non-site-mode page', () => {
    const headers = buildPreviewResponseHeaders(buildBaselineCsp());
    expect(headers?.['Content-Security-Policy']).toContain("script-src 'unsafe-inline'");
    expect(headers?.['Content-Security-Policy']).toContain("frame-ancestors 'self'");
  });

  it('given any policy, should mark the response private and uncacheable, since it is per-viewer', () => {
    const headers = buildPreviewResponseHeaders(buildSiteCsp());
    expect(headers?.['Cache-Control']).toContain('no-store');
    expect(headers?.['Cache-Control']).toContain('private');
  });

  it('given any policy, should serve as HTML', () => {
    const headers = buildPreviewResponseHeaders(buildSiteCsp());
    expect(headers?.['Content-Type']).toBe('text/html; charset=utf-8');
  });
});

import { describe, it, expect } from 'vitest';
import { buildPreviewResponseHeaders, PREVIEW_SANDBOX_TOKENS } from '../preview-headers';
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
    expect(headers?.['Content-Security-Policy']).toBe(
      `default-src 'none'; frame-ancestors 'self'; sandbox ${PREVIEW_SANDBOX_TOKENS}`,
    );
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

  // The preview document is reachable at a real, authenticated, SAME-ORIGIN url.
  // The iframe `sandbox` attribute does not travel with it, so a direct
  // navigation — which author JS can trigger itself, since the frame is granted
  // `allow-popups-to-escape-sandbox` — would otherwise run author script as a
  // first-party document on the app origin with the viewer's cookies. That is
  // stored XSS. The response-level sandbox is what makes the isolation a
  // property of the DOCUMENT rather than of one particular embedding.
  it('given any policy, should carry a CSP sandbox so direct navigation is isolated too', () => {
    const headers = buildPreviewResponseHeaders(buildSiteCsp());
    expect(headers?.['Content-Security-Policy']).toMatch(/(^|;)\s*sandbox\s/);
  });

  it('given any policy, should NEVER grant allow-same-origin in the sandbox directive', () => {
    for (const policy of [buildSiteCsp(), buildBaselineCsp(), "default-src 'none'"]) {
      const csp = buildPreviewResponseHeaders(policy)!['Content-Security-Policy'];
      const sandbox = /(?:^|;)\s*sandbox([^;]*)/.exec(csp)?.[1] ?? '';
      expect(sandbox).not.toContain('allow-same-origin');
    }
  });

  it('given any policy, should grant the same sandbox tokens the frame does, so both load paths behave alike', () => {
    const csp = buildPreviewResponseHeaders(buildSiteCsp())!['Content-Security-Policy'];
    const sandbox = /(?:^|;)\s*sandbox([^;]*)/.exec(csp)![1].trim().split(/\s+/);
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).toContain('allow-popups');
    expect(sandbox).toContain('allow-popups-to-escape-sandbox');
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

import { describe, it, expect } from 'vitest';
import { buildBaselineCsp, buildCanvasCsp, buildDocumentCsp, buildSiteCsp } from '../csp';

describe('buildBaselineCsp', () => {
  it('defaults to form-action \'none\' when no origin is given', () => {
    const csp = buildBaselineCsp();
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain('connect-src');
  });

  it('scopes form-action and connect-src to the given origin only', () => {
    const csp = buildBaselineCsp('https://app.pagespace.ai');
    expect(csp).toContain("form-action 'self' https://app.pagespace.ai");
    expect(csp).toContain('connect-src https://app.pagespace.ai');
  });

  it('never widens form-action to a wildcard', () => {
    const csp = buildBaselineCsp('https://app.pagespace.ai');
    expect(csp).not.toContain('form-action *');
  });

  it('preserves every other baseline directive unchanged', () => {
    const withOrigin = buildBaselineCsp('https://app.pagespace.ai');
    expect(withOrigin).toContain("default-src 'none'");
    expect(withOrigin).toContain("object-src 'none'");
    expect(withOrigin).toContain("base-uri 'none'");
    expect(withOrigin).toContain("script-src 'unsafe-inline'");
  });
});

describe('buildSiteCsp', () => {
  it('lets a site load scripts from any https host', () => {
    const csp = buildSiteCsp();
    expect(csp).toContain('script-src');
    expect(csp).toMatch(/script-src[^;]*\bhttps:/);
  });

  it('lets a site reach any https origin over fetch and any wss origin over websocket', () => {
    const csp = buildSiteCsp();
    expect(csp).toMatch(/connect-src[^;]*\bhttps:/);
    expect(csp).toMatch(/connect-src[^;]*\bwss:/);
  });

  it("still pins object-src and base-uri to 'none' — neither is needed by a real website", () => {
    const csp = buildSiteCsp();
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it('keeps a deny-by-default base so an undeclared directive stays blocked', () => {
    const csp = buildSiteCsp();
    expect(csp).toContain("default-src 'none'");
  });

  it('still permits form submission to the PageSpace forms endpoint', () => {
    const csp = buildSiteCsp();
    expect(csp).toMatch(/form-action[^;]*\bhttps:/);
    expect(csp).not.toContain("form-action 'none'");
  });

  it('leaves the baseline policy untouched, so nothing already published widens', () => {
    const baseline = buildBaselineCsp();
    expect(baseline).not.toContain('connect-src');
    expect(baseline).toContain("script-src 'unsafe-inline'");
    expect(baseline).not.toMatch(/script-src[^;]*\bhttps:/);
  });
});

describe('buildDocumentCsp', () => {
  it('blocks scripts entirely', () => {
    const csp = buildDocumentCsp();
    expect(csp).toContain("script-src 'none'");
  });

  it('blocks form submission entirely', () => {
    const csp = buildDocumentCsp();
    expect(csp).toContain("form-action 'none'");
  });

  it('keeps the baseline asset/image/font/object/base-uri directives', () => {
    const csp = buildDocumentCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('img-src data: https:');
    expect(csp).toContain("style-src 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain('font-src https://fonts.gstatic.com');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });
});

describe('buildCanvasCsp', () => {
  it('serves the site policy for a site-mode page', () => {
    expect(buildCanvasCsp(true)).toBe(buildSiteCsp());
  });

  it('serves the baseline policy scoped to the origin otherwise', () => {
    expect(buildCanvasCsp(false, 'https://app.pagespace.ai')).toBe(
      buildBaselineCsp('https://app.pagespace.ai'),
    );
  });

  it('treats an absent flag as not site mode, never as a widened policy', () => {
    // `renderCanvasDocument` takes `siteMode` as optional, so a caller that omits
    // it must land on the restrictive policy, not the permissive one.
    expect(buildCanvasCsp()).toBe(buildBaselineCsp());
    expect(buildCanvasCsp(undefined)).toBe(buildBaselineCsp());
  });

  it('ignores the origin under site mode, which needs none', () => {
    expect(buildCanvasCsp(true, 'https://app.pagespace.ai')).toBe(buildCanvasCsp(true));
  });
});

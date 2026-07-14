import { describe, it, expect } from 'vitest';
import { buildBaselineCsp, buildDocumentCsp } from '../csp';

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

import { describe, it, expect } from 'vitest';
import { buildBaselineCsp } from '../csp';

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

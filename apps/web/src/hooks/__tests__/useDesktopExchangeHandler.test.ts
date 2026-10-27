import { describe, it, expect } from 'vitest';

import {
  buildDesktopExchangeDeepLink,
  extractDesktopExchangeCode,
} from '../useDesktopExchangeHandler';

describe('buildDesktopExchangeDeepLink', () => {
  it('builds a pagespace:// deep link with the exchange code', () => {
    const url = buildDesktopExchangeDeepLink('abc123');
    expect(url).toContain('pagespace://auth-exchange');
    expect(url).toContain('code=abc123');
    expect(url).toContain('provider=magic-link');
  });

  it('omits state when none is provided (web / older desktop builds)', () => {
    expect(buildDesktopExchangeDeepLink('abc123')).not.toContain('state=');
    expect(buildDesktopExchangeDeepLink('abc123', null)).not.toContain('state=');
    expect(buildDesktopExchangeDeepLink('abc123', '')).not.toContain('state=');
  });

  it('forwards the desktop-instance state for exact-match binding (L9)', () => {
    const url = buildDesktopExchangeDeepLink('abc123', 'deadbeef');
    expect(url).toContain('state=deadbeef');
    expect(url).toContain('code=abc123');
  });
});

describe('extractDesktopExchangeCode', () => {
  it('returns the exchange code on desktop when param is present', () => {
    expect(extractDesktopExchangeCode('?auth=success&desktopExchange=abc123')).toBe('abc123');
  });

  it('returns the exchange code in a plain browser too (the emailed link never opens in the shell)', () => {
    expect(extractDesktopExchangeCode('?desktopExchange=abc123')).toBe('abc123');
  });

  it('returns null when no desktopExchange param', () => {
    expect(extractDesktopExchangeCode('?auth=success')).toBeNull();
  });

  it('returns null for empty search', () => {
    expect(extractDesktopExchangeCode('')).toBeNull();
  });
});

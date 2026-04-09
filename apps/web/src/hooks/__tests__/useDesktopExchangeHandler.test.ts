import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/desktop-auth', () => ({
  isDesktopPlatform: vi.fn(),
}));

import { isDesktopPlatform } from '@/lib/desktop-auth';
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
});

describe('extractDesktopExchangeCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns exchange code on desktop when param is present', () => {
    vi.mocked(isDesktopPlatform).mockReturnValue(true);
    expect(extractDesktopExchangeCode('?auth=success&desktopExchange=abc123')).toBe('abc123');
  });

  it('returns null when no desktopExchange param', () => {
    vi.mocked(isDesktopPlatform).mockReturnValue(true);
    expect(extractDesktopExchangeCode('?auth=success')).toBeNull();
  });

  it('returns null on web even with desktopExchange param', () => {
    vi.mocked(isDesktopPlatform).mockReturnValue(false);
    expect(extractDesktopExchangeCode('?desktopExchange=abc123')).toBeNull();
  });

  it('returns null for empty search', () => {
    vi.mocked(isDesktopPlatform).mockReturnValue(true);
    expect(extractDesktopExchangeCode('')).toBeNull();
  });
});

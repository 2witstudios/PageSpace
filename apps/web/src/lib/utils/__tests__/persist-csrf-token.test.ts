import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/utils/get-cookie-value', () => ({
  getCookieValue: vi.fn(),
}));

import { persistCsrfToken } from '../persist-csrf-token';
import { getCookieValue } from '@/lib/utils/get-cookie-value';

describe('persist-csrf-token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('should persist CSRF token to localStorage when cookie exists', () => {
    vi.mocked(getCookieValue).mockReturnValue('test-csrf-token');
    persistCsrfToken();
    expect(localStorage.getItem('csrfToken')).toBe('test-csrf-token');
  });

  it('should not persist when cookie does not exist', () => {
    vi.mocked(getCookieValue).mockReturnValue(null);
    persistCsrfToken();
    expect(localStorage.getItem('csrfToken')).toBeNull();
  });

  it('should handle localStorage errors gracefully', () => {
    vi.mocked(getCookieValue).mockReturnValue('test-token');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage full');
    });

    expect(() => persistCsrfToken()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith('Failed to persist CSRF token:', expect.any(Error));

    warnSpy.mockRestore();
  });
});

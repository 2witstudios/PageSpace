import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockCreateCSRFHook = vi.hoisted(() => vi.fn());

vi.mock('../createCSRFHook', () => ({
  createCSRFHook: mockCreateCSRFHook,
}));

describe('useCSRFToken', () => {
  const mockHook = vi.fn();
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    mockCreateCSRFHook.mockReset();
    mockHook.mockReset();
    mockCreateCSRFHook.mockReturnValue(mockHook);
    mockHook.mockReturnValue({
      csrfToken: null,
      isLoading: false,
      error: null,
      refreshToken: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call createCSRFHook with /api/auth/csrf endpoint', async () => {
    vi.resetModules();

    vi.doMock('../createCSRFHook', () => ({
      createCSRFHook: mockCreateCSRFHook,
    }));
    mockCreateCSRFHook.mockReturnValue(mockHook);
    mockHook.mockReturnValue({
      csrfToken: null,
      isLoading: false,
      error: null,
      refreshToken: vi.fn(),
    });

    await import('../useCSRFToken');

    expect(mockCreateCSRFHook).toHaveBeenCalledWith('/api/auth/csrf');
  });

  it('should export the hook returned by createCSRFHook', async () => {
    vi.resetModules();

    vi.doMock('../createCSRFHook', () => ({
      createCSRFHook: mockCreateCSRFHook,
    }));
    mockCreateCSRFHook.mockReturnValue(mockHook);
    mockHook.mockReturnValue({
      csrfToken: 'csrf-token-value',
      isLoading: false,
      error: null,
      refreshToken: vi.fn(),
    });

    const { useCSRFToken } = await import('../useCSRFToken');

    expect(useCSRFToken).toBe(mockHook);
  });

  it('should fetch from the csrf endpoint when used directly', async () => {
    vi.resetModules();
    vi.doUnmock('../createCSRFHook');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ csrfToken: 'real-csrf-token' }),
    });

    const { useCSRFToken } = await import('../useCSRFToken');
    const { result } = renderHook(() => useCSRFToken());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/auth/csrf', {
      credentials: 'include',
    });
    expect(result.current.csrfToken).toBe('real-csrf-token');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockCreateCSRFHook = vi.hoisted(() => vi.fn());

vi.mock('../createCSRFHook', () => ({
  createCSRFHook: mockCreateCSRFHook,
}));

describe('useAuthCSRF', () => {
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

  it('should call createCSRFHook with /api/auth/login-csrf endpoint', async () => {
    // Force re-import to trigger module evaluation
    vi.resetModules();

    // Re-setup the mock since resetModules clears it
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

    await import('../useAuthCSRF');

    expect(mockCreateCSRFHook).toHaveBeenCalledWith('/api/auth/login-csrf');
  });

  it('should export the hook returned by createCSRFHook', async () => {
    vi.resetModules();

    vi.doMock('../createCSRFHook', () => ({
      createCSRFHook: mockCreateCSRFHook,
    }));
    mockCreateCSRFHook.mockReturnValue(mockHook);
    mockHook.mockReturnValue({
      csrfToken: 'auth-csrf-token',
      isLoading: false,
      error: null,
      refreshToken: vi.fn(),
    });

    const { useAuthCSRF } = await import('../useAuthCSRF');

    expect(useAuthCSRF).toBe(mockHook);
  });

  it('should fetch from the login-csrf endpoint when used directly', async () => {
    // Use real implementation to verify endpoint
    vi.resetModules();
    vi.doUnmock('../createCSRFHook');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ csrfToken: 'real-auth-token' }),
    });

    const { useAuthCSRF } = await import('../useAuthCSRF');
    const { result } = renderHook(() => useAuthCSRF());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/auth/login-csrf', {
      credentials: 'include',
    });
    expect(result.current.csrfToken).toBe('real-auth-token');
  });
});

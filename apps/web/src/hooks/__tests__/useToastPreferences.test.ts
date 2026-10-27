import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockUseSWR = vi.hoisted(() => vi.fn());
const mockUseAuth = vi.hoisted(() => vi.fn());

vi.mock('swr', () => ({ default: mockUseSWR }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: mockUseAuth }));
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  patch: vi.fn(),
}));

import { useToastPreferences } from '../useToastPreferences';

describe('useToastPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSWR.mockReturnValue({ data: undefined, isLoading: false, mutate: vi.fn() });
  });

  it('does not fetch the preference while unauthenticated', () => {
    mockUseAuth.mockReturnValue({ user: null });
    renderHook(() => useToastPreferences());

    expect(mockUseSWR).toHaveBeenCalledWith(null, expect.any(Function), expect.anything());
  });

  it('fetches the preference once a user is present', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'user-1' } });
    renderHook(() => useToastPreferences());

    expect(mockUseSWR).toHaveBeenCalledWith(
      '/api/settings/toast-preferences',
      expect.any(Function),
      expect.anything(),
    );
  });

  it('defaults to level all when no data has loaded yet', () => {
    mockUseAuth.mockReturnValue({ user: null });
    const { result } = renderHook(() => useToastPreferences());

    expect(result.current.level).toBe('all');
  });

  it('returns the fetched level once data resolves', () => {
    mockUseAuth.mockReturnValue({ user: { id: 'user-1' } });
    mockUseSWR.mockReturnValue({ data: { level: 'mentions' }, isLoading: false, mutate: vi.fn() });
    const { result } = renderHook(() => useToastPreferences());

    expect(result.current.level).toBe('mentions');
  });
});

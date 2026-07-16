import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSigninRecovery } from '../useSigninRecovery';

// Shell-level coverage for the recovery effect. The DECISION branches live in
// signin-recovery.test.ts; here we assert the effects are wired to the right actions:
// a live /api/auth/me redirects, an expired cookie + device token refreshes then redirects,
// and an unrecoverable state renders the form.

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));

const refreshAuthSession = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  refreshAuthSession: () => refreshAuthSession(),
}));

const isCapacitorApp = vi.fn(() => false);
vi.mock('@/lib/capacitor-bridge', () => ({
  isCapacitorApp: () => isCapacitorApp(),
}));

let authFailedPermanently = false;
vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ authFailedPermanently }) },
}));

function mockMe(ok: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok }) as Response),
  );
}

beforeEach(() => {
  replace.mockClear();
  refreshAuthSession.mockReset();
  isCapacitorApp.mockReturnValue(false);
  authFailedPermanently = false;
  localStorage.clear();
  // Default: window.electron absent (pure web).
  delete (window as unknown as { electron?: unknown }).electron;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSigninRecovery', () => {
  it('redirects to the next path when the session is already live', async () => {
    mockMe(true);

    const { result } = renderHook(() => useSigninRecovery('/dashboard/deep'));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard/deep'));
    // Stays in the recovering state through the navigation so the form never flashes.
    expect(result.current.recovering).toBe(true);
  });

  it('defaults to /dashboard when no next path is resolved', async () => {
    mockMe(true);

    renderHook(() => useSigninRecovery(undefined));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
  });

  it('refreshes via the device token then redirects when the cookie is expired', async () => {
    mockMe(false);
    localStorage.setItem('deviceToken', 'dt_valid');
    refreshAuthSession.mockResolvedValue({ success: true, shouldLogout: false });

    renderHook(() => useSigninRecovery('/dashboard'));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
    expect(refreshAuthSession).toHaveBeenCalledTimes(1);
  });

  it('renders the form (no redirect) when the cookie is expired and there is no device token', async () => {
    mockMe(false);

    const { result } = renderHook(() => useSigninRecovery('/dashboard'));

    await waitFor(() => expect(result.current.recovering).toBe(false));
    expect(replace).not.toHaveBeenCalled();
    expect(refreshAuthSession).not.toHaveBeenCalled();
  });

  it('renders the form when the device-token refresh fails, without looping', async () => {
    mockMe(false);
    localStorage.setItem('deviceToken', 'dt_revoked');
    refreshAuthSession.mockResolvedValue({ success: false, shouldLogout: true });

    const { result } = renderHook(() => useSigninRecovery('/dashboard'));

    await waitFor(() => expect(result.current.recovering).toBe(false));
    expect(replace).not.toHaveBeenCalled();
    expect(refreshAuthSession).toHaveBeenCalledTimes(1);
  });

  it('renders the form immediately when auth has permanently failed (no /api/auth/me, no loop)', async () => {
    authFailedPermanently = true;
    localStorage.setItem('deviceToken', 'dt_valid');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() => useSigninRecovery('/dashboard'));

    await waitFor(() => expect(result.current.recovering).toBe(false));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('skips recovery in a native shell and renders the form', async () => {
    isCapacitorApp.mockReturnValue(true);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() => useSigninRecovery('/dashboard'));

    await waitFor(() => expect(result.current.recovering).toBe(false));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

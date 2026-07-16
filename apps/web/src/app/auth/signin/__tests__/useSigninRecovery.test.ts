import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { useSigninRecovery } from '../useSigninRecovery';

// Shell-level coverage for the recovery effect. The DECISION branches live in
// signin-recovery.test.ts; here we assert the effects are wired to the right actions:
// a live /api/auth/me redirects, an expired cookie + device token refreshes then redirects,
// and an unrecoverable state renders the form. We also cover the two subtleties the shell
// alone carries: it must not start before the redirect destination is resolved (readiness),
// and it must survive React StrictMode's dev mount probe.

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

    const { result } = renderHook(() => useSigninRecovery('/dashboard/deep', true));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard/deep'));
    // Stays in the recovering state through the navigation so the form never flashes.
    expect(result.current.recovering).toBe(true);
  });

  it('defaults to /dashboard when no next path is resolved', async () => {
    mockMe(true);

    renderHook(() => useSigninRecovery(undefined, true));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
  });

  it('refreshes via the device token then redirects when the cookie is expired', async () => {
    mockMe(false);
    localStorage.setItem('deviceToken', 'dt_valid');
    refreshAuthSession.mockResolvedValue({ success: true, shouldLogout: false });

    renderHook(() => useSigninRecovery('/dashboard', true));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
    expect(refreshAuthSession).toHaveBeenCalledTimes(1);
  });

  it('renders the form (no redirect) when the cookie is expired and there is no device token', async () => {
    mockMe(false);

    const { result } = renderHook(() => useSigninRecovery('/dashboard', true));

    await waitFor(() => expect(result.current.recovering).toBe(false));
    expect(replace).not.toHaveBeenCalled();
    expect(refreshAuthSession).not.toHaveBeenCalled();
  });

  it('renders the form when the device-token refresh fails, without looping', async () => {
    mockMe(false);
    localStorage.setItem('deviceToken', 'dt_revoked');
    refreshAuthSession.mockResolvedValue({ success: false, shouldLogout: true });

    const { result } = renderHook(() => useSigninRecovery('/dashboard', true));

    await waitFor(() => expect(result.current.recovering).toBe(false));
    expect(replace).not.toHaveBeenCalled();
    expect(refreshAuthSession).toHaveBeenCalledTimes(1);
  });

  it('renders the form immediately when auth has permanently failed (no /api/auth/me, no loop)', async () => {
    authFailedPermanently = true;
    localStorage.setItem('deviceToken', 'dt_valid');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() => useSigninRecovery('/dashboard', true));

    await waitFor(() => expect(result.current.recovering).toBe(false));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('skips recovery in a native shell and renders the form', async () => {
    isCapacitorApp.mockReturnValue(true);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() => useSigninRecovery('/dashboard', true));

    await waitFor(() => expect(result.current.recovering).toBe(false));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not start recovery until ready — no /api/auth/me while the destination is unresolved', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchSpy);

    renderHook(() => useSigninRecovery(undefined, false));

    // Give any (incorrectly-scheduled) effect a chance to run.
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('redirects to the deep link resolved after mount, not the default dashboard', async () => {
    // Mirrors the middleware-rewrite flow: nextPath is undefined until browserPath resolves,
    // at which point `ready` flips true and the resolved deep link is available.
    mockMe(true);

    const { rerender } = renderHook(
      ({ nextPath, ready }: { nextPath: string | undefined; ready: boolean }) =>
        useSigninRecovery(nextPath, ready),
      { initialProps: { nextPath: undefined as string | undefined, ready: false } },
    );

    // First render: destination not yet known, recovery must not have started.
    await Promise.resolve();
    expect(replace).not.toHaveBeenCalled();

    // browserPath resolves → ready flips true with the recovered deep link.
    rerender({ nextPath: '/dashboard/drv_abc/pg_xyz', ready: true });

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard/drv_abc/pg_xyz'));
    expect(replace).not.toHaveBeenCalledWith('/dashboard');
  });

  it('completes recovery under React StrictMode (does not get stuck on loading)', async () => {
    mockMe(false); // unrecoverable → terminal 'show-form' → recovering flips false

    const { result } = renderHook(() => useSigninRecovery('/dashboard', true), {
      wrapper: StrictMode,
    });

    // Under StrictMode the effect is set up, torn down, then set up again on mount. The
    // second run must complete rather than being stranded by a latched guard.
    await waitFor(() => expect(result.current.recovering).toBe(false));
  });
});

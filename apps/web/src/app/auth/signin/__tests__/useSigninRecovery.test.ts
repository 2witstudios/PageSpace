import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { useSigninRecovery } from '../useSigninRecovery';

// Shell-level coverage for the recovery effect. The DECISION branches live in
// signin-recovery.test.ts; here we assert the effects are wired to the right actions AND to the
// right platform-routed primitives (D1): check-me goes through fetchWithAuth (Bearer-attaching,
// refresh-on-401), and hasDeviceToken reads PLATFORM storage (safeStorage over IPC on desktop),
// never localStorage directly. We also cover the two subtleties the shell alone carries: it must
// not start before the redirect destination is resolved (readiness), and it must survive React
// StrictMode's dev mount probe.

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));

const fetchWithAuth = vi.fn();
const refreshAuthSession = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  refreshAuthSession: () => refreshAuthSession(),
}));

// The platform-storage seam: desktop returns a session read from safeStorage over IPC, web from
// localStorage. The shell only ever touches it through getPlatformStorage().getStoredSession().
const getStoredSession = vi.fn();
let storagePlatform: 'web' | 'desktop' | 'ios' | 'android' = 'web';
vi.mock('@/lib/auth/platform-storage', () => ({
  getPlatformStorage: () => ({ platform: storagePlatform, getStoredSession }),
}));

let authFailedPermanently = false;
vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ authFailedPermanently }) },
}));

// check-me result via fetchWithAuth('/api/auth/me').
function mockMe(ok: boolean) {
  fetchWithAuth.mockResolvedValue({ ok } as Response);
}

beforeEach(() => {
  replace.mockClear();
  fetchWithAuth.mockReset();
  refreshAuthSession.mockReset();
  getStoredSession.mockReset();
  getStoredSession.mockResolvedValue(null); // default: no device token
  storagePlatform = 'web';
  authFailedPermanently = false;
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it('checks the session through fetchWithAuth (Bearer-attaching), not raw fetch', async () => {
    mockMe(true);
    const rawFetch = vi.spyOn(globalThis, 'fetch');

    renderHook(() => useSigninRecovery('/dashboard', true));

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ credentials: 'include' }));
    expect(rawFetch).not.toHaveBeenCalled();
  });

  it('refreshes via the device token then redirects when the cookie is expired', async () => {
    mockMe(false);
    getStoredSession.mockResolvedValue({ deviceToken: 'dt_valid' });
    refreshAuthSession.mockResolvedValue({ success: true, shouldLogout: false });

    renderHook(() => useSigninRecovery('/dashboard', true));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
    expect(refreshAuthSession).toHaveBeenCalledTimes(1);
  });

  it('renders the form (no redirect) when the cookie is expired and there is no device token', async () => {
    mockMe(false);
    getStoredSession.mockResolvedValue(null);

    const { result } = renderHook(() => useSigninRecovery('/dashboard', true));

    await waitFor(() => expect(result.current.recovering).toBe(false));
    expect(replace).not.toHaveBeenCalled();
    expect(refreshAuthSession).not.toHaveBeenCalled();
  });

  it('renders the form when the device-token refresh fails, without looping', async () => {
    mockMe(false);
    getStoredSession.mockResolvedValue({ deviceToken: 'dt_revoked' });
    refreshAuthSession.mockResolvedValue({ success: false, shouldLogout: true });

    const { result } = renderHook(() => useSigninRecovery('/dashboard', true));

    await waitFor(() => expect(result.current.recovering).toBe(false));
    expect(replace).not.toHaveBeenCalled();
    expect(refreshAuthSession).toHaveBeenCalledTimes(1);
  });

  it('renders the form immediately when auth has permanently failed (no check-me, no loop)', async () => {
    authFailedPermanently = true;
    getStoredSession.mockResolvedValue({ deviceToken: 'dt_valid' });

    const { result } = renderHook(() => useSigninRecovery('/dashboard', true));

    await waitFor(() => expect(result.current.recovering).toBe(false));
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  // ── D1 acceptance: native shells now run the SAME recovery machine ───────────────────────
  describe('desktop (native shell)', () => {
    beforeEach(() => {
      storagePlatform = 'desktop';
    });

    it('an authenticated check-me redirects — no signin form shown (acceptance #1)', async () => {
      // safeStorage holds a valid session; check-me succeeds so we never even need the token.
      getStoredSession.mockResolvedValue({ deviceToken: 'safe_dt' });
      mockMe(true);

      const { result } = renderHook(() => useSigninRecovery('/dashboard/deep', true));

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard/deep'));
      expect(result.current.recovering).toBe(true); // stays recovering through the nav — no form
    });

    it('check-me carries a Bearer token (via fetchWithAuth) and hasDeviceToken reads platform storage, not localStorage (acceptance #2)', async () => {
      getStoredSession.mockResolvedValue({ deviceToken: 'safe_dt' });
      mockMe(true);
      const lsSpy = vi.spyOn(Storage.prototype, 'getItem');

      renderHook(() => useSigninRecovery('/dashboard', true));

      await waitFor(() => expect(replace).toHaveBeenCalled());
      // Bearer path: goes through the auth-fetch wrapper, never raw fetch.
      expect(fetchWithAuth).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ credentials: 'include' }));
      // Device token read from safeStorage over IPC, not from localStorage.
      expect(getStoredSession).toHaveBeenCalled();
      expect(lsSpy).not.toHaveBeenCalledWith('deviceToken');
    });

    it('a successful device refresh redirects to /dashboard (acceptance #3)', async () => {
      getStoredSession.mockResolvedValue({ deviceToken: 'safe_dt' });
      mockMe(false); // cookie/session gone
      refreshAuthSession.mockResolvedValue({ success: true, shouldLogout: false });

      renderHook(() => useSigninRecovery('/dashboard', true));

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
      expect(refreshAuthSession).toHaveBeenCalledTimes(1);
    });

    it('NO redirect loop: when genuinely unauthenticated, authFailedPermanently wins and the form is shown (acceptance #4)', async () => {
      // The loop-guard must short-circuit BEFORE any check-me/refresh — proving it, not the
      // absence of a token, is what stops the check-me→refresh→bounce loop on desktop.
      authFailedPermanently = true;
      getStoredSession.mockResolvedValue({ deviceToken: 'safe_dt' });

      const { result } = renderHook(() => useSigninRecovery('/dashboard', true));

      await waitFor(() => expect(result.current.recovering).toBe(false));
      expect(fetchWithAuth).not.toHaveBeenCalled();
      expect(refreshAuthSession).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
    });

    it('shows the form when unauthenticated with no recoverable token (terminates, no loop)', async () => {
      mockMe(false);
      getStoredSession.mockResolvedValue({ deviceToken: null });

      const { result } = renderHook(() => useSigninRecovery('/dashboard', true));

      await waitFor(() => expect(result.current.recovering).toBe(false));
      expect(replace).not.toHaveBeenCalled();
      expect(refreshAuthSession).not.toHaveBeenCalled();
    });
  });

  // ── Web regression: behavior is identical to before D1 ───────────────────────────────────
  it('web: expired cookie + valid device token still refreshes and redirects (acceptance #5)', async () => {
    storagePlatform = 'web';
    mockMe(false);
    getStoredSession.mockResolvedValue({ deviceToken: 'dt_valid' });
    refreshAuthSession.mockResolvedValue({ success: true, shouldLogout: false });

    renderHook(() => useSigninRecovery('/dashboard', true));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
    expect(refreshAuthSession).toHaveBeenCalledTimes(1);
  });

  it('does not start recovery until ready — no check-me while the destination is unresolved', async () => {
    mockMe(true);

    renderHook(() => useSigninRecovery(undefined, false));

    // Give any (incorrectly-scheduled) effect a chance to run.
    await Promise.resolve();
    expect(fetchWithAuth).not.toHaveBeenCalled();
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

  it('fails open to the form if the device-token refresh rejects (never strands on loading)', async () => {
    // The driver is best-effort: a thrown rejection anywhere must fall back to the form
    // rather than leave the page stuck on the loading state forever.
    mockMe(false);
    getStoredSession.mockResolvedValue({ deviceToken: 'dt_valid' });
    refreshAuthSession.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useSigninRecovery('/dashboard', true));

    await waitFor(() => expect(result.current.recovering).toBe(false));
    expect(replace).not.toHaveBeenCalled();
  });

  it('fails open to the form if the check-me fetch itself rejects', async () => {
    fetchWithAuth.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useSigninRecovery('/dashboard', true));

    await waitFor(() => expect(result.current.recovering).toBe(false));
    expect(replace).not.toHaveBeenCalled();
  });

  it('runs recovery only once even if the component re-renders while ready stays true', async () => {
    mockMe(false);

    const { rerender, result } = renderHook(
      ({ n }: { n: number }) => useSigninRecovery(`/dashboard?r=${n}`, true),
      { initialProps: { n: 1 } },
    );

    await waitFor(() => expect(result.current.recovering).toBe(false));
    // A re-render with ready still true (e.g. a searchParams-driven update) must not re-run.
    rerender({ n: 2 });
    await Promise.resolve();

    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
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

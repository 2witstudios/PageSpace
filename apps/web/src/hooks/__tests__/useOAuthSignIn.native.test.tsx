import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * The hook's native branches had no coverage at all. They decide whether a
 * sign-in attempt goes to the native SDK or to web OAuth, and — the part worth
 * pinning — that a *failed* native attempt is reported rather than silently
 * retried through the web flow.
 *
 * That last point looks like a missing fallback and is not. The task page asks
 * for one ("given the native plugin is unavailable, should fall back to web
 * OAuth rather than leaving the caller with no session"), but there is no
 * working web OAuth inside either native shell to fall back TO: iOS allowlists
 * accounts.google.com so the flow stays in the WebView and Google answers
 * `disallowed_useragent` (`apps/ios/capacitor.config.ts`); Android does not
 * allowlist it, so the flow leaves for the external browser and the session
 * cookie lands in the wrong jar; and the `pagespace://auth-exchange` handoff
 * that would close the gap has no consumer, because nothing listens for
 * `appUrlOpen` on either platform (`apps/android/README.md`, "Prerequisite 2").
 * Falling through would trade a visible error inside a working app for a silent
 * dead end outside it. These tests hold that line.
 */

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m) } }));

const routerReplace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: routerReplace }) }));

vi.mock('@/lib/desktop-auth', () => ({ isDesktopPlatform: () => false }));
vi.mock('@/lib/auth/desktop-shell', () => ({
  currentDesktopShell: () => undefined,
  DESKTOP_SHELLS: ['pagespace', 'coder'],
}));
vi.mock('@/lib/analytics', () => ({
  getOrCreateDeviceId: () => 'device-1',
  getDeviceName: () => 'Test Device',
}));

const googleAvailable = vi.fn(() => true);
const signInWithGoogle = vi.fn();
vi.mock('@/lib/native-google-auth', () => ({
  isNativeGoogleAuthAvailable: () => googleAvailable(),
  signInWithGoogle: (o: unknown) => signInWithGoogle(o),
}));

const appleAvailable = vi.fn(() => true);
const signInWithApple = vi.fn();
vi.mock('@/lib/native-apple-auth', () => ({
  isNativeAppleAuthAvailable: () => appleAvailable(),
  signInWithApple: (o: unknown) => signInWithApple(o),
}));

import { useOAuthSignIn } from '../useOAuthSignIn';

describe('useOAuthSignIn: native sign-in branches', () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    googleAvailable.mockReturnValue(true);
    appleAvailable.mockReturnValue(true);
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://accounts.google.com/o/oauth2/auth?x=1' }), { status: 200 })
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;
    Object.defineProperty(window, 'location', { value: { href: '' }, writable: true });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('given the native plugin could not load, should report it and NOT navigate out to a dead web flow', async () => {
    signInWithGoogle.mockResolvedValue({ success: false, error: 'Native Google sign-in unavailable' });

    const { result } = renderHook(() => useOAuthSignIn());
    await act(async () => { await result.current.handleGoogleSignIn(); });

    expect(toastError).toHaveBeenCalledWith('Native Google sign-in unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('given a native Apple failure, should report it rather than starting the web flow', async () => {
    signInWithApple.mockResolvedValue({ success: false, error: 'Native Apple sign-in unavailable' });

    const { result } = renderHook(() => useOAuthSignIn());
    await act(async () => { await result.current.handleAppleSignIn(); });

    expect(toastError).toHaveBeenCalledWith('Native Apple sign-in unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('given a genuine native failure, should report it and NOT silently retry through the web flow', async () => {
    signInWithGoogle.mockResolvedValue({ success: false, error: 'Google rejected the token' });

    const { result } = renderHook(() => useOAuthSignIn());
    await act(async () => { await result.current.handleGoogleSignIn(); });

    expect(toastError).toHaveBeenCalledWith('Google rejected the token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('given the user cancelled, should stay silent and not fall back', async () => {
    signInWithGoogle.mockResolvedValue({ success: false, error: 'Sign-in cancelled' });

    const { result } = renderHook(() => useOAuthSignIn());
    await act(async () => { await result.current.handleGoogleSignIn(); });

    expect(toastError).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('given a successful native sign-in, should not touch the web flow', async () => {
    signInWithGoogle.mockResolvedValue({ success: true, user: { id: 'u1', name: 'A', email: 'a@b.c' } });

    const { result } = renderHook(() => useOAuthSignIn());
    await act(async () => { await result.current.handleGoogleSignIn(); });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(routerReplace).toHaveBeenCalledWith('/dashboard');
  });

  it('given the platform has no native provider at all, should go straight to web OAuth', async () => {
    googleAvailable.mockReturnValue(false);

    const { result } = renderHook(() => useOAuthSignIn());
    await act(async () => { await result.current.handleGoogleSignIn(); });

    expect(signInWithGoogle).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/google/signin', expect.anything());
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Task-page requirement: "Given the native plugin is unavailable, should fall
 * back to web OAuth rather than leaving the caller with no session."
 *
 * The native modules cannot do that themselves — they report `unavailable` and
 * this hook decides. The distinction matters: a shell built without the
 * social-login plugin, or one whose native side did not register, would
 * otherwise leave the user staring at an error toast on a button that can never
 * work, while the web flow beside it works fine. Every *other* failure — a
 * cancel, a rejected token, an unconfigured client — is about this attempt and
 * must still be reported rather than silently retried through a second flow.
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

describe('useOAuthSignIn: falling back when the native path cannot run', () => {
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

  it('given the native Google plugin is unavailable, should start the web OAuth flow', async () => {
    signInWithGoogle.mockResolvedValue({ success: false, unavailable: true, error: 'Native Google sign-in unavailable' });

    const { result } = renderHook(() => useOAuthSignIn());
    await act(async () => { await result.current.handleGoogleSignIn(); });

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/google/signin', expect.anything());
    expect(toastError).not.toHaveBeenCalled();
  });

  it('given the native Apple plugin is unavailable, should start the web OAuth flow', async () => {
    signInWithApple.mockResolvedValue({ success: false, unavailable: true });

    const { result } = renderHook(() => useOAuthSignIn());
    await act(async () => { await result.current.handleAppleSignIn(); });

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/apple/signin', expect.anything());
    expect(toastError).not.toHaveBeenCalled();
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

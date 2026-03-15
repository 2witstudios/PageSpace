/**
 * useOAuthSignIn Hook Tests
 *
 * Tests OAuth sign-in flows:
 * - Google sign-in success/failure
 * - Apple sign-in success/failure
 * - Native vs web flow
 * - Loading states
 * - Double-click prevention
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockPush = vi.hoisted(() => vi.fn());
const mockReplace = vi.hoisted(() => vi.fn());

const mockToast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

const mockSetAuthFailedPermanently = vi.hoisted(() => vi.fn());
const mockSetUser = vi.hoisted(() => vi.fn());

const mockIsNativeGoogleAuthAvailable = vi.hoisted(() => vi.fn(() => false));
const mockSignInWithGoogle = vi.hoisted(() => vi.fn());

const mockIsNativeAppleAuthAvailable = vi.hoisted(() => vi.fn(() => false));
const mockSignInWithApple = vi.hoisted(() => vi.fn());

const mockGetOrCreateDeviceId = vi.hoisted(() => vi.fn(() => 'test-device-id'));
const mockGetDeviceName = vi.hoisted(() => vi.fn(() => 'Test Browser'));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('sonner', () => ({
  toast: mockToast,
}));

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({
      setAuthFailedPermanently: mockSetAuthFailedPermanently,
      setUser: mockSetUser,
    }),
  },
}));

vi.mock('@/lib/ios-google-auth', () => ({
  isNativeGoogleAuthAvailable: mockIsNativeGoogleAuthAvailable,
  signInWithGoogle: mockSignInWithGoogle,
}));

vi.mock('@/lib/ios-apple-auth', () => ({
  isNativeAppleAuthAvailable: mockIsNativeAppleAuthAvailable,
  signInWithApple: mockSignInWithApple,
}));

vi.mock('@/lib/analytics', () => ({
  getOrCreateDeviceId: mockGetOrCreateDeviceId,
  getDeviceName: mockGetDeviceName,
}));

import { useOAuthSignIn } from '../useOAuthSignIn';

describe('useOAuthSignIn', () => {
  const originalFetch = global.fetch;
  const originalLocationHref = window.location.href;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();

    // Mock window.location.href setter
    Object.defineProperty(window, 'location', {
      value: { ...window.location, href: originalLocationHref },
      configurable: true,
      writable: true,
    });

    // Ensure no electron
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('initial state', () => {
    it('should return loading states as false initially', () => {
      const { result } = renderHook(() => useOAuthSignIn());

      expect(result.current.isGoogleLoading).toBe(false);
      expect(result.current.isAppleLoading).toBe(false);
    });

    it('should return handler functions', () => {
      const { result } = renderHook(() => useOAuthSignIn());

      expect(typeof result.current.handleGoogleSignIn).toBe('function');
      expect(typeof result.current.handleAppleSignIn).toBe('function');
    });
  });

  describe('Google sign-in - web flow', () => {
    it('should initiate web OAuth flow when native auth is not available', async () => {
      mockIsNativeGoogleAuthAvailable.mockReturnValue(false);
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ url: 'https://accounts.google.com/oauth' }),
      });

      const { result } = renderHook(() => useOAuthSignIn());

      await act(async () => {
        await result.current.handleGoogleSignIn();
      });

      expect(global.fetch).toHaveBeenCalledWith('/api/auth/google/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('"deviceId"'),
      });
    });

    it('should show error when web OAuth fails', async () => {
      mockIsNativeGoogleAuthAvailable.mockReturnValue(false);
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'OAuth configuration error' }),
      });

      const { result } = renderHook(() => useOAuthSignIn());

      await act(async () => {
        await result.current.handleGoogleSignIn();
      });

      expect(mockToast.error).toHaveBeenCalledWith('OAuth configuration error');
    });

    it('should show default error message when no error in response', async () => {
      mockIsNativeGoogleAuthAvailable.mockReturnValue(false);
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        json: vi.fn().mockResolvedValue({}),
      });

      const { result } = renderHook(() => useOAuthSignIn());

      await act(async () => {
        await result.current.handleGoogleSignIn();
      });

      expect(mockToast.error).toHaveBeenCalledWith(
        'Google sign-in failed. Please try again.'
      );
    });
  });

  describe('Google sign-in - native flow', () => {
    it('should use native Google auth when available', async () => {
      mockIsNativeGoogleAuthAvailable.mockReturnValue(true);
      mockSignInWithGoogle.mockResolvedValue({
        success: true,
        isNewUser: false,
        user: { id: 'u1', name: 'Test', email: 'test@example.com' },
      });

      const { result } = renderHook(() => useOAuthSignIn());

      await act(async () => {
        await result.current.handleGoogleSignIn();
      });

      expect(mockSignInWithGoogle).toHaveBeenCalled();
      expect(mockSetAuthFailedPermanently).toHaveBeenCalledWith(false);
      expect(mockSetUser).toHaveBeenCalledWith({
        id: 'u1',
        name: 'Test',
        email: 'test@example.com',
      });
      expect(mockReplace).toHaveBeenCalledWith('/dashboard');
    });

    it('should navigate to welcome page for new users', async () => {
      mockIsNativeGoogleAuthAvailable.mockReturnValue(true);
      mockSignInWithGoogle.mockResolvedValue({
        success: true,
        isNewUser: true,
        user: { id: 'u1', name: 'New User', email: 'new@example.com' },
      });

      const { result } = renderHook(() => useOAuthSignIn());

      await act(async () => {
        await result.current.handleGoogleSignIn();
      });

      expect(mockReplace).toHaveBeenCalledWith('/dashboard?welcome=true');
    });

    it('should show error for failed native Google sign-in', async () => {
      mockIsNativeGoogleAuthAvailable.mockReturnValue(true);
      mockSignInWithGoogle.mockResolvedValue({
        success: false,
        error: 'Token exchange failed',
      });

      const { result } = renderHook(() => useOAuthSignIn());

      await act(async () => {
        await result.current.handleGoogleSignIn();
      });

      expect(mockToast.error).toHaveBeenCalledWith('Token exchange failed');
    });

    it('should not show error when user cancels sign-in', async () => {
      mockIsNativeGoogleAuthAvailable.mockReturnValue(true);
      mockSignInWithGoogle.mockResolvedValue({
        success: false,
        error: 'Sign-in cancelled',
      });

      const { result } = renderHook(() => useOAuthSignIn());

      await act(async () => {
        await result.current.handleGoogleSignIn();
      });

      expect(mockToast.error).not.toHaveBeenCalled();
    });
  });

  describe('Apple sign-in - web flow', () => {
    it('should initiate web OAuth flow for Apple when native is not available', async () => {
      mockIsNativeAppleAuthAvailable.mockReturnValue(false);
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ url: 'https://appleid.apple.com/auth' }),
      });

      const { result } = renderHook(() => useOAuthSignIn());

      await act(async () => {
        await result.current.handleAppleSignIn();
      });

      expect(global.fetch).toHaveBeenCalledWith('/api/auth/apple/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('"deviceId"'),
      });
    });

    it('should show error when web Apple OAuth fails', async () => {
      mockIsNativeAppleAuthAvailable.mockReturnValue(false);
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        json: vi.fn().mockResolvedValue({ error: 'Apple OAuth error' }),
      });

      const { result } = renderHook(() => useOAuthSignIn());

      await act(async () => {
        await result.current.handleAppleSignIn();
      });

      expect(mockToast.error).toHaveBeenCalledWith('Apple OAuth error');
    });
  });

  describe('Apple sign-in - native flow', () => {
    it('should use native Apple auth when available', async () => {
      mockIsNativeAppleAuthAvailable.mockReturnValue(true);
      mockSignInWithApple.mockResolvedValue({
        success: true,
        isNewUser: false,
        user: { id: 'u2', name: 'Apple User', email: 'apple@example.com' },
      });

      const { result } = renderHook(() => useOAuthSignIn());

      await act(async () => {
        await result.current.handleAppleSignIn();
      });

      expect(mockSignInWithApple).toHaveBeenCalled();
      expect(mockSetAuthFailedPermanently).toHaveBeenCalledWith(false);
      expect(mockReplace).toHaveBeenCalledWith('/dashboard');
    });

    it('should show error for failed native Apple sign-in', async () => {
      mockIsNativeAppleAuthAvailable.mockReturnValue(true);
      mockSignInWithApple.mockResolvedValue({
        success: false,
        error: 'Apple auth token invalid',
      });

      const { result } = renderHook(() => useOAuthSignIn());

      await act(async () => {
        await result.current.handleAppleSignIn();
      });

      expect(mockToast.error).toHaveBeenCalledWith('Apple auth token invalid');
    });

    it('should not show error when Apple sign-in is cancelled', async () => {
      mockIsNativeAppleAuthAvailable.mockReturnValue(true);
      mockSignInWithApple.mockResolvedValue({
        success: false,
        error: 'Sign-in cancelled',
      });

      const { result } = renderHook(() => useOAuthSignIn());

      await act(async () => {
        await result.current.handleAppleSignIn();
      });

      expect(mockToast.error).not.toHaveBeenCalled();
    });
  });

  describe('loading states', () => {
    it('should set isGoogleLoading during Google sign-in', async () => {
      mockIsNativeGoogleAuthAvailable.mockReturnValue(false);
      let resolvePromise: () => void;
      const promise = new Promise<Response>((resolve) => {
        resolvePromise = () =>
          resolve({
            ok: true,
            json: () => Promise.resolve({ url: 'https://google.com' }),
          } as Response);
      });
      (global.fetch as ReturnType<typeof vi.fn>).mockReturnValue(promise);

      const { result } = renderHook(() => useOAuthSignIn());

      expect(result.current.isGoogleLoading).toBe(false);

      // Start sign-in but don't await yet
      let signInPromise: Promise<void>;
      act(() => {
        signInPromise = result.current.handleGoogleSignIn();
      });

      expect(result.current.isGoogleLoading).toBe(true);

      // Resolve the fetch
      await act(async () => {
        resolvePromise!();
        await signInPromise;
      });

      expect(result.current.isGoogleLoading).toBe(false);
    });

    it('should set isAppleLoading during Apple sign-in', async () => {
      mockIsNativeAppleAuthAvailable.mockReturnValue(false);
      let resolvePromise: () => void;
      const promise = new Promise<Response>((resolve) => {
        resolvePromise = () =>
          resolve({
            ok: true,
            json: () => Promise.resolve({ url: 'https://apple.com' }),
          } as Response);
      });
      (global.fetch as ReturnType<typeof vi.fn>).mockReturnValue(promise);

      const { result } = renderHook(() => useOAuthSignIn());

      expect(result.current.isAppleLoading).toBe(false);

      let signInPromise: Promise<void>;
      act(() => {
        signInPromise = result.current.handleAppleSignIn();
      });

      expect(result.current.isAppleLoading).toBe(true);

      await act(async () => {
        resolvePromise!();
        await signInPromise;
      });

      expect(result.current.isAppleLoading).toBe(false);
    });

    it('should reset loading state after network error on Google', async () => {
      mockIsNativeGoogleAuthAvailable.mockReturnValue(false);
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error')
      );

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useOAuthSignIn());

      await act(async () => {
        await result.current.handleGoogleSignIn();
      });

      expect(result.current.isGoogleLoading).toBe(false);
      expect(mockToast.error).toHaveBeenCalledWith(
        'Network error. Please check your connection and try again.'
      );

      consoleSpy.mockRestore();
    });

    it('should reset loading state after network error on Apple', async () => {
      mockIsNativeAppleAuthAvailable.mockReturnValue(false);
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error')
      );

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useOAuthSignIn());

      await act(async () => {
        await result.current.handleAppleSignIn();
      });

      expect(result.current.isAppleLoading).toBe(false);
      expect(mockToast.error).toHaveBeenCalledWith(
        'Network error. Please check your connection and try again.'
      );

      consoleSpy.mockRestore();
    });
  });

  describe('double-click prevention', () => {
    it('should prevent double-click on Google sign-in', async () => {
      mockIsNativeGoogleAuthAvailable.mockReturnValue(false);
      let resolvePromise: () => void;
      const promise = new Promise<Response>((resolve) => {
        resolvePromise = () =>
          resolve({
            ok: true,
            json: () => Promise.resolve({ url: 'https://google.com' }),
          } as Response);
      });
      (global.fetch as ReturnType<typeof vi.fn>).mockReturnValue(promise);

      const { result } = renderHook(() => useOAuthSignIn());

      // First click
      let firstPromise: Promise<void>;
      act(() => {
        firstPromise = result.current.handleGoogleSignIn();
      });

      // Second click while loading
      await act(async () => {
        await result.current.handleGoogleSignIn();
      });

      // Only one fetch call should have been made
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Clean up
      await act(async () => {
        resolvePromise!();
        await firstPromise;
      });
    });

    it('should prevent double-click on Apple sign-in', async () => {
      mockIsNativeAppleAuthAvailable.mockReturnValue(false);
      let resolvePromise: () => void;
      const promise = new Promise<Response>((resolve) => {
        resolvePromise = () =>
          resolve({
            ok: true,
            json: () => Promise.resolve({ url: 'https://apple.com' }),
          } as Response);
      });
      (global.fetch as ReturnType<typeof vi.fn>).mockReturnValue(promise);

      const { result } = renderHook(() => useOAuthSignIn());

      // First click
      let firstPromise: Promise<void>;
      act(() => {
        firstPromise = result.current.handleAppleSignIn();
      });

      // Second click while loading
      await act(async () => {
        await result.current.handleAppleSignIn();
      });

      // Only one fetch call should have been made
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Clean up
      await act(async () => {
        resolvePromise!();
        await firstPromise;
      });
    });
  });

  describe('callbacks', () => {
    it('should call onStart when Google sign-in begins', async () => {
      const onStart = vi.fn();
      mockIsNativeGoogleAuthAvailable.mockReturnValue(true);
      mockSignInWithGoogle.mockResolvedValue({
        success: true,
        user: { id: 'u1', name: 'Test', email: 'test@example.com' },
      });

      const { result } = renderHook(() => useOAuthSignIn({ onStart }));

      await act(async () => {
        await result.current.handleGoogleSignIn();
      });

      expect(onStart).toHaveBeenCalledOnce();
    });

    it('should call onError when Google sign-in fails', async () => {
      const onError = vi.fn();
      mockIsNativeGoogleAuthAvailable.mockReturnValue(true);
      mockSignInWithGoogle.mockResolvedValue({
        success: false,
        error: 'Auth failed',
      });

      const { result } = renderHook(() => useOAuthSignIn({ onError }));

      await act(async () => {
        await result.current.handleGoogleSignIn();
      });

      expect(onError).toHaveBeenCalledWith('Auth failed');
    });

    it('should call onStart when Apple sign-in begins', async () => {
      const onStart = vi.fn();
      mockIsNativeAppleAuthAvailable.mockReturnValue(true);
      mockSignInWithApple.mockResolvedValue({
        success: true,
        user: { id: 'u2', name: 'Apple User', email: 'apple@example.com' },
      });

      const { result } = renderHook(() => useOAuthSignIn({ onStart }));

      await act(async () => {
        await result.current.handleAppleSignIn();
      });

      expect(onStart).toHaveBeenCalledOnce();
    });
  });
});

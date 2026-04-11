import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useConditionalPasskeyUI } from '../useConditionalPasskeyUI';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
}));
vi.mock('@/lib/utils/persist-csrf-token', () => ({ persistCsrfToken: vi.fn() }));
vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ setAuthFailedPermanently: vi.fn() }) },
}));
vi.mock('@/lib/desktop-auth', () => ({
  getDevicePlatformFields: vi.fn().mockResolvedValue({}),
  handleDesktopAuthResponse: vi.fn().mockResolvedValue(false),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

beforeEach(() => {
  vi.stubGlobal('PublicKeyCredential', {
    isConditionalMediationAvailable: () => Promise.resolve(false),
  });
});

describe('useConditionalPasskeyUI', () => {
  it('given stable csrfToken and stable option refs, should return stable startConditionalUI', () => {
    const refreshToken = vi.fn();
    const onSuccess = vi.fn();

    const { result, rerender } = renderHook(
      ({ token }) =>
        useConditionalPasskeyUI(token, { refreshToken, onSuccess }),
      { initialProps: { token: 'csrf-1' } }
    );

    const firstRef = result.current.startConditionalUI;

    rerender({ token: 'csrf-1' });

    expect(result.current.startConditionalUI).toBe(firstRef);
  });

  it('given csrfToken changes, should return new startConditionalUI', () => {
    const refreshToken = vi.fn();
    const onSuccess = vi.fn();

    const { result, rerender } = renderHook(
      ({ token }) =>
        useConditionalPasskeyUI(token, { refreshToken, onSuccess }),
      { initialProps: { token: 'csrf-1' } }
    );

    const firstRef = result.current.startConditionalUI;

    rerender({ token: 'csrf-2' });

    expect(result.current.startConditionalUI).not.toBe(firstRef);
  });

  it('given inline onSuccess arrow (new ref each render), should still return stable startConditionalUI', () => {
    // This matches real usage in signin/page.tsx where onSuccess is an inline arrow
    const { result, rerender } = renderHook(
      ({ token }) =>
        useConditionalPasskeyUI(token, {
          refreshToken: async () => 'refreshed',
          onSuccess: (url) => { window.location.href = url; },
        }),
      { initialProps: { token: 'csrf-1' } }
    );

    const firstRef = result.current.startConditionalUI;

    // Re-render — options object and its callbacks are new refs
    rerender({ token: 'csrf-1' });

    expect(result.current.startConditionalUI).toBe(firstRef);
  });

  it('given inline refreshToken (new ref each render), should still return stable startConditionalUI', () => {
    const { result, rerender } = renderHook(
      ({ token }) =>
        useConditionalPasskeyUI(token, {
          refreshToken: async () => token,
          onSuccess: vi.fn(),
        }),
      { initialProps: { token: 'csrf-1' } }
    );

    const firstRef = result.current.startConditionalUI;

    rerender({ token: 'csrf-1' });

    expect(result.current.startConditionalUI).toBe(firstRef);
  });
});

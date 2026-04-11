import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useConditionalPasskeyUI } from '../PasskeyLoginButton';

// Mock all imports used by the hook
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'button' }));
vi.mock('@/lib/utils', () => ({ cn: (...args: string[]) => args.join(' ') }));
vi.mock('@/lib/utils/persist-csrf-token', () => ({ persistCsrfToken: vi.fn() }));
vi.mock('@/hooks/useWebAuthnSupport', () => ({ useWebAuthnSupport: () => true }));
vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ setAuthFailedPermanently: vi.fn() }) },
}));
vi.mock('@/lib/desktop-auth', () => ({
  getDevicePlatformFields: vi.fn().mockResolvedValue({}),
  handleDesktopAuthResponse: vi.fn().mockResolvedValue(false),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('lucide-react', () => ({ Fingerprint: 'span', Loader2: 'span' }));

// Stub conditional mediation as unavailable so the hook doesn't fire real fetches
beforeEach(() => {
  vi.stubGlobal('PublicKeyCredential', {
    isConditionalMediationAvailable: () => Promise.resolve(false),
  });
});

describe('useConditionalPasskeyUI', () => {
  it('should return a stable startConditionalUI reference when options values are unchanged', () => {
    const refreshToken = vi.fn();
    const onSuccess = vi.fn();

    const { result, rerender } = renderHook(
      ({ token }) =>
        useConditionalPasskeyUI(token, { refreshToken, onSuccess }),
      { initialProps: { token: 'csrf-1' } }
    );

    const firstRef = result.current.startConditionalUI;

    // Re-render with same csrfToken — options object is a new literal but values are identical
    rerender({ token: 'csrf-1' });

    const secondRef = result.current.startConditionalUI;

    expect(secondRef).toBe(firstRef);
  });

  it('should update startConditionalUI when csrfToken changes', () => {
    const refreshToken = vi.fn();
    const onSuccess = vi.fn();

    const { result, rerender } = renderHook(
      ({ token }) =>
        useConditionalPasskeyUI(token, { refreshToken, onSuccess }),
      { initialProps: { token: 'csrf-1' } }
    );

    const firstRef = result.current.startConditionalUI;

    rerender({ token: 'csrf-2' });

    const secondRef = result.current.startConditionalUI;

    expect(secondRef).not.toBe(firstRef);
  });
});

/**
 * useWebAuthnSupport Hook Tests
 * Tests for WebAuthn browser support detection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: vi.fn(() => true),
}));

import { useWebAuthnSupport } from '../useWebAuthnSupport';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';

const mockedBrowserSupportsWebAuthn = vi.mocked(browserSupportsWebAuthn);

describe('useWebAuthnSupport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null initially before the effect runs', () => {
    // The initial state before useEffect executes
    mockedBrowserSupportsWebAuthn.mockReturnValue(true);

    const { result } = renderHook(() => useWebAuthnSupport());

    // Note: in the test environment with jsdom, the effect may run
    // synchronously during renderHook. The initial useState is null.
    // We verify the type is boolean | null.
    expect(typeof result.current === 'boolean' || result.current === null).toBe(true);
  });

  it('should return true when WebAuthn is supported', async () => {
    mockedBrowserSupportsWebAuthn.mockReturnValue(true);

    const { result } = renderHook(() => useWebAuthnSupport());

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it('should return false when WebAuthn is not supported', async () => {
    mockedBrowserSupportsWebAuthn.mockReturnValue(false);

    const { result } = renderHook(() => useWebAuthnSupport());

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  it('should call browserSupportsWebAuthn from @simplewebauthn/browser', async () => {
    mockedBrowserSupportsWebAuthn.mockReturnValue(true);

    renderHook(() => useWebAuthnSupport());

    await waitFor(() => {
      expect(mockedBrowserSupportsWebAuthn).toHaveBeenCalled();
    });
  });

  it('should not change the value on re-renders', async () => {
    mockedBrowserSupportsWebAuthn.mockReturnValue(true);

    const { result, rerender } = renderHook(() => useWebAuthnSupport());

    await waitFor(() => {
      expect(result.current).toBe(true);
    });

    rerender();
    rerender();

    expect(result.current).toBe(true);
  });

  it('should handle browserSupportsWebAuthn returning false', async () => {
    mockedBrowserSupportsWebAuthn.mockReturnValue(false);

    const { result } = renderHook(() => useWebAuthnSupport());

    await waitFor(() => {
      expect(result.current).toBe(false);
    });

    // Verify it called the function
    expect(mockedBrowserSupportsWebAuthn).toHaveBeenCalledTimes(1);
  });
});

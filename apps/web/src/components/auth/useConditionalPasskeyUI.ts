'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { WebAuthnAbortService } from '@simplewebauthn/browser';
import { toast } from 'sonner';
import { persistCsrfToken } from '@/lib/utils/persist-csrf-token';
import { useAuthStore } from '@/stores/useAuthStore';
import { getDevicePlatformFields, handleDesktopAuthResponse } from '@/lib/desktop-auth';
import {
  deriveRefreshIntervalMs,
  driveCeremony,
  handleCeremonyResult,
  runCeremony,
} from './conditionalPasskeyCeremony';

export interface ConditionalPasskeyOptions {
  refreshToken?: () => Promise<string | null>;
  onSuccess?: (redirectUrl: string) => void;
}

/**
 * Hook for conditional UI support (passkey autofill).
 * Call startConditionalUI() after render so the input with
 * autocomplete="email webauthn" is already in the DOM (per spec).
 */
export function useConditionalPasskeyUI(
  csrfToken: string,
  options?: ConditionalPasskeyOptions
) {
  const [isAvailable, setIsAvailable] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const mountedRef = useRef(true);

  // Refs for callbacks — keeps startConditionalUI stable when callers
  // pass inline arrows (common in JSX). The callback always reads the
  // latest ref, so callers don't need to memoize.
  const refreshTokenRef = useRef(options?.refreshToken);
  refreshTokenRef.current = options?.refreshToken;

  const onSuccessRef = useRef(options?.onSuccess);
  onSuccessRef.current = options?.onSuccess;

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      WebAuthnAbortService.cancelCeremony();
    };
  }, []);

  useEffect(() => {
    const checkAvailability = async () => {
      if (typeof window === 'undefined') return;

      const available = await (
        window.PublicKeyCredential?.isConditionalMediationAvailable?.() ??
        Promise.resolve(false)
      );

      if (mountedRef.current) setIsAvailable(available);
    };

    checkAvailability();
  }, []);

  const startConditionalUI = useCallback(async () => {
    if (!isAvailable || !csrfToken) return;

    if (mountedRef.current) setIsAuthenticating(true);

    const result = await driveCeremony({
      isMounted: () => mountedRef.current,
      runOnce: () =>
        runCeremony({
          csrfToken,
          refreshIntervalMs: deriveRefreshIntervalMs(),
          refreshToken: refreshTokenRef.current,
          getDevicePlatformFields,
          isMounted: () => mountedRef.current,
        }),
    });

    if (mountedRef.current) setIsAuthenticating(false);

    await handleCeremonyResult({
      result,
      handleDesktopAuthResponse,
      onFailure: (message) => {
        toast.error(message);
      },
      onAuthenticated: () => {
        persistCsrfToken();
        useAuthStore.getState().setAuthFailedPermanently(false);
        toast.success('Signed in successfully');
      },
      onRedirect: (redirectUrl) => {
        if (onSuccessRef.current) {
          onSuccessRef.current(redirectUrl);
        } else {
          window.location.href = redirectUrl;
        }
      },
    });
  }, [isAvailable, csrfToken]);

  return {
    isAvailable,
    isAuthenticating,
    startConditionalUI,
  };
}

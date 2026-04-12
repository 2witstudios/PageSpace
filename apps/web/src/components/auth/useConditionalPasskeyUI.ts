'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  startAuthentication,
  WebAuthnAbortService,
  WebAuthnError,
} from '@simplewebauthn/browser';
import { toast } from 'sonner';
import { persistCsrfToken } from '@/lib/utils/persist-csrf-token';
import { useAuthStore } from '@/stores/useAuthStore';
import { getDevicePlatformFields, handleDesktopAuthResponse } from '@/lib/desktop-auth';

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

    try {
      const platformFields = await getDevicePlatformFields();

      const optionsRes = await fetch('/api/auth/passkey/authenticate/options', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ csrfToken }),
      });

      if (!optionsRes.ok || !mountedRef.current) return;

      const { options: authOptions } = await optionsRes.json();

      if (mountedRef.current) setIsAuthenticating(true);

      const authResponse = await startAuthentication({
        optionsJSON: authOptions,
        useBrowserAutofill: true,
      });

      if (!mountedRef.current) return;

      // Refresh CSRF token before verify — user may have idled on the page
      const freshToken = refreshTokenRef.current
        ? (await refreshTokenRef.current() ?? csrfToken)
        : csrfToken;

      const verifyRes = await fetch('/api/auth/passkey/authenticate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response: authResponse,
          expectedChallenge: authOptions.challenge,
          csrfToken: freshToken,
          ...platformFields,
        }),
      });

      if (!mountedRef.current) return;

      if (!verifyRes.ok) {
        const error = await verifyRes.json();
        toast.error(error.error || 'Authentication failed');
        return;
      }

      const verifyData = await verifyRes.json();

      persistCsrfToken();
      useAuthStore.getState().setAuthFailedPermanently(false);

      toast.success('Signed in successfully');

      if (await handleDesktopAuthResponse(verifyData)) return;

      if (onSuccessRef.current) {
        onSuccessRef.current(verifyData.redirectUrl);
      } else {
        window.location.href = verifyData.redirectUrl;
      }
    } catch (err) {
      // SimpleWebAuthn throws WebAuthnError with ERROR_CEREMONY_ABORTED when
      // cancelCeremony() is called (unmount, new ceremony). Also ignore DOM
      // AbortError for the same reason.
      if (err instanceof WebAuthnError && err.code === 'ERROR_CEREMONY_ABORTED') {
        return;
      }
      if (err instanceof Error && err.name !== 'AbortError') {
        console.debug('Conditional UI authentication failed:', err.message);
      }
    } finally {
      if (mountedRef.current) setIsAuthenticating(false);
    }
  }, [isAvailable, csrfToken]);

  return {
    isAvailable,
    isAuthenticating,
    startConditionalUI,
  };
}

'use client';

import { useState, useCallback, useEffect } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { Fingerprint, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { persistCsrfToken } from '@/lib/utils/persist-csrf-token';
import { useWebAuthnSupport } from '@/hooks/useWebAuthnSupport';
import { useAuthStore } from '@/stores/useAuthStore';
import { getDevicePlatformFields, handleDesktopAuthResponse } from '@/lib/desktop-auth';

interface PasskeyLoginButtonProps {
  csrfToken: string;
  refreshToken?: () => Promise<string | null>;
  email?: string;
  onSuccess?: (redirectUrl: string) => void;
  className?: string;
  variant?: 'default' | 'outline' | 'secondary';
}

export function PasskeyLoginButton({
  csrfToken,
  refreshToken,
  email,
  onSuccess,
  className,
  variant = 'outline',
}: PasskeyLoginButtonProps) {
  const isSupported = useWebAuthnSupport();
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const handleLogin = useCallback(async () => {
    if (!csrfToken) {
      toast.error('Please wait for security token to load');
      return;
    }

    setIsAuthenticating(true);

    try {
      // Refresh CSRF token to avoid expiry after sitting on the page
      const freshToken = refreshToken ? (await refreshToken() ?? csrfToken) : csrfToken;

      const platformFields = await getDevicePlatformFields();

      // Get authentication options
      const optionsRes = await fetch('/api/auth/passkey/authenticate/options', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          csrfToken: freshToken,
        }),
      });

      if (!optionsRes.ok) {
        const error = await optionsRes.json();
        toast.error(error.error || 'Failed to start authentication');
        return;
      }

      const { options } = await optionsRes.json();

      // Check if there are any credentials to authenticate with
      if (email && (!options.allowCredentials || options.allowCredentials.length === 0)) {
        toast.error('No passkeys found for this email');
        return;
      }

      // Start WebAuthn ceremony
      const authResponse = await startAuthentication({ optionsJSON: options });

      // Verify authentication
      const verifyRes = await fetch('/api/auth/passkey/authenticate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response: authResponse,
          expectedChallenge: options.challenge,
          csrfToken: freshToken,
          ...platformFields,
        }),
      });

      if (!verifyRes.ok) {
        const error = await verifyRes.json();
        if (error.code === 'USER_SUSPENDED') {
          toast.error('Your account has been suspended');
        } else if (error.code === 'CREDENTIAL_NOT_FOUND') {
          toast.error('Passkey not found. It may have been deleted.');
        } else if (error.code === 'COUNTER_REPLAY_DETECTED') {
          toast.error('Security error: Please try again or use a different sign-in method');
        } else {
          toast.error(error.error || 'Authentication failed');
        }
        return;
      }

      const verifyData = await verifyRes.json();

      persistCsrfToken();
      useAuthStore.getState().setAuthFailedPermanently(false);

      toast.success('Signed in successfully');

      if (await handleDesktopAuthResponse(verifyData)) return;

      if (onSuccess) {
        onSuccess(verifyData.redirectUrl);
      } else {
        window.location.href = verifyData.redirectUrl;
      }
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError') {
          toast.error('Authentication was cancelled');
        } else if (err.name === 'InvalidStateError') {
          toast.error('No matching passkey found');
        } else {
          toast.error(`Authentication failed: ${err.message}`);
        }
      } else {
        toast.error('Authentication failed');
      }
    } finally {
      setIsAuthenticating(false);
    }
  }, [csrfToken, refreshToken, email, onSuccess]);

  // Don't render if browser doesn't support WebAuthn
  if (isSupported === false) {
    return null;
  }

  return (
    <Button
      variant={variant}
      onClick={handleLogin}
      disabled={isAuthenticating || isSupported === null}
      className={cn('w-full', className)}
    >
      {isAuthenticating ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Authenticating...
        </>
      ) : (
        <>
          <Fingerprint className="mr-2 h-4 w-4" />
          Sign in with Passkey
        </>
      )}
    </Button>
  );
}

/**
 * Hook for conditional UI support (passkey autofill).
 * Call this on page load to start conditional UI in the background.
 */
export function useConditionalPasskeyUI(
  csrfToken: string,
  onSuccess?: (redirectUrl: string) => void
) {
  const [isAvailable, setIsAvailable] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  useEffect(() => {
    const checkAvailability = async () => {
      if (typeof window === 'undefined') return;

      // Check if conditional mediation is available
      const available = await (
        window.PublicKeyCredential?.isConditionalMediationAvailable?.() ??
        Promise.resolve(false)
      );

      setIsAvailable(available);
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

      if (!optionsRes.ok) return;

      const { options } = await optionsRes.json();

      setIsAuthenticating(true);

      const authResponse = await startAuthentication({
        optionsJSON: options,
        useBrowserAutofill: true,
      });

      const verifyRes = await fetch('/api/auth/passkey/authenticate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response: authResponse,
          expectedChallenge: options.challenge,
          csrfToken,
          ...platformFields,
        }),
      });

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

      if (onSuccess) {
        onSuccess(verifyData.redirectUrl);
      } else {
        window.location.href = verifyData.redirectUrl;
      }
    } catch (err) {
      // Conditional UI was cancelled or failed - this is expected behavior
      // Don't show error toast for AbortError (user cancelled)
      if (err instanceof Error && err.name !== 'AbortError') {
        console.debug('Conditional UI authentication failed:', err.message);
      }
    } finally {
      setIsAuthenticating(false);
    }
  }, [isAvailable, csrfToken, onSuccess]);

  return {
    isAvailable,
    isAuthenticating,
    startConditionalUI,
  };
}

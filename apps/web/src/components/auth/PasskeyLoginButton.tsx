'use client';

import { useState, useCallback } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { Fingerprint, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { persistCsrfToken } from '@/lib/utils/persist-csrf-token';
import { useWebAuthnSupport } from '@/hooks/useWebAuthnSupport';
import { useAuthStore } from '@/stores/useAuthStore';
import {
  getDevicePlatformFields,
  handleDesktopAuthResponse,
  isDesktopPlatform,
} from '@/lib/desktop-auth';
import { buildPasskeyExternalUrl } from './passkeyExternal';

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
  variant = 'default',
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
      // Desktop (Electron): delegate the WebAuthn ceremony to the system
      // browser via the auth:open-external IPC. Electron's Chromium cannot
      // drive platform authenticators on macOS without extra entitlements,
      // so we mirror the OAuth flow: open an external page that runs the
      // ceremony and hands back a one-time exchange code over the
      // pagespace:// deep link.
      if (isDesktopPlatform()) {
        // The server rejects platform=desktop without desktopExchange, and
        // Chromium inside the Electron BrowserWindow cannot drive platform
        // authenticators without entitlements we don't ship — so an older
        // desktop bridge that lacks the openExternal IPC has no working
        // sign-in path. Surface a clear update prompt instead of silently
        // falling through to a request the server will reject with 400.
        if (!window.electron?.auth?.openExternal) {
          toast.error(
            'Your desktop app needs to be updated to sign in with a passkey. Please update the app and try again.'
          );
          return;
        }

        const fields = await getDevicePlatformFields();
        if (!('deviceId' in fields) || !fields.deviceId) {
          toast.error('Could not read desktop device info');
          return;
        }
        const externalUrl = buildPasskeyExternalUrl(window.location.origin, {
          deviceId: fields.deviceId,
          deviceName: fields.deviceName,
        });
        const result = await window.electron.auth.openExternal(externalUrl);
        if (!result.success) {
          toast.error(result.error || 'Failed to open browser for sign-in');
          return;
        }
        toast.info('Complete sign-in in your browser, then return here.');
        return;
      }

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


'use client';

import { useState, useCallback, useEffect } from 'react';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { Fingerprint, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { persistCsrfToken } from '@/lib/utils/persist-csrf-token';

interface PasskeySignupButtonProps {
  csrfToken: string;
  email: string;
  name: string;
  acceptedTos: boolean;
  onSuccess?: (redirectUrl: string) => void;
  onEmailExists?: () => void;
  className?: string;
  disabled?: boolean;
}

export function PasskeySignupButton({
  csrfToken,
  email,
  name,
  acceptedTos,
  onSuccess,
  onEmailExists,
  className,
  disabled = false,
}: PasskeySignupButtonProps) {
  const [isSupported, setIsSupported] = useState<boolean | null>(null);
  const [isRegistering, setIsRegistering] = useState(false);

  useEffect(() => {
    setIsSupported(browserSupportsWebAuthn());
  }, []);

  const handleSignup = useCallback(async () => {
    if (!csrfToken) {
      toast.error('Please wait for security token to load');
      return;
    }

    if (!email || !name) {
      toast.error('Please enter your name and email');
      return;
    }

    if (!acceptedTos) {
      toast.error('Please accept the Terms of Service');
      return;
    }

    setIsRegistering(true);

    try {
      // Get registration options
      const optionsRes = await fetch('/api/auth/signup-passkey/options', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          name,
          csrfToken,
        }),
      });

      if (!optionsRes.ok) {
        const error = await optionsRes.json();
        if (error.code === 'EMAIL_EXISTS') {
          toast.error('An account with this email already exists. Please sign in instead.');
          onEmailExists?.();
          return;
        }
        toast.error(error.error || 'Failed to start registration');
        return;
      }

      const { options } = await optionsRes.json();

      // Start WebAuthn registration ceremony
      const regResponse = await startRegistration({ optionsJSON: options });

      // Verify registration and create account
      const verifyRes = await fetch('/api/auth/signup-passkey', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          name,
          response: regResponse,
          expectedChallenge: options.challenge,
          csrfToken,
          acceptedTos,
        }),
      });

      if (!verifyRes.ok) {
        const error = await verifyRes.json();
        if (error.code === 'EMAIL_EXISTS') {
          toast.error('An account with this email already exists. Please sign in instead.');
          onEmailExists?.();
          return;
        }
        if (error.code === 'CHALLENGE_EXPIRED') {
          toast.error('Session expired. Please try again.');
          return;
        }
        toast.error(error.error || 'Registration failed');
        return;
      }

      const { redirectUrl } = await verifyRes.json();

      persistCsrfToken();

      toast.success('Account created successfully!');

      if (onSuccess) {
        onSuccess(redirectUrl);
      } else {
        window.location.href = redirectUrl;
      }
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError') {
          toast.error('Registration was cancelled');
        } else if (err.name === 'InvalidStateError') {
          toast.error('A passkey is already registered with this device');
        } else if (err.name === 'AbortError') {
          toast.error('Registration timed out. Please try again.');
        } else {
          toast.error(`Registration failed: ${err.message}`);
        }
      } else {
        toast.error('Registration failed');
      }
    } finally {
      setIsRegistering(false);
    }
  }, [csrfToken, email, name, acceptedTos, onSuccess, onEmailExists]);

  // Don't render if browser doesn't support WebAuthn
  if (isSupported === false) {
    return null;
  }

  const isDisabled = disabled || isRegistering || isSupported === null || !email || !name || !acceptedTos;

  return (
    <Button
      onClick={handleSignup}
      disabled={isDisabled}
      className={cn('w-full', className)}
    >
      {isRegistering ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Creating account...
        </>
      ) : (
        <>
          <Fingerprint className="mr-2 h-4 w-4" />
          Create with Passkey
        </>
      )}
    </Button>
  );
}

/**
 * Hook to check if WebAuthn is supported in the current browser.
 */
export function useWebAuthnSupport() {
  const [isSupported, setIsSupported] = useState<boolean | null>(null);

  useEffect(() => {
    setIsSupported(browserSupportsWebAuthn());
  }, []);

  return isSupported;
}

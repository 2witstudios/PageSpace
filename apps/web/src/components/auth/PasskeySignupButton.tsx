'use client';

import { useState, useCallback, useEffect } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Fingerprint, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { persistCsrfToken } from '@/lib/utils/persist-csrf-token';
import { useWebAuthnSupport } from '@/hooks/useWebAuthnSupport';
import { useAuthStore } from '@/stores/useAuthStore';
import { getDevicePlatformFields, handleDesktopAuthResponse } from '@/lib/desktop-auth';

interface PasskeySignupButtonProps {
  csrfToken: string;
  refreshToken?: () => Promise<string | null>;
  onSuccess?: (redirectUrl: string) => void;
  onEmailExists?: () => void;
  onLoadingChange?: (isLoading: boolean) => void;
  className?: string;
  disabled?: boolean;
}

export function PasskeySignupButton({
  csrfToken,
  refreshToken,
  onSuccess,
  onEmailExists,
  onLoadingChange,
  className,
  disabled = false,
}: PasskeySignupButtonProps) {
  const isSupported = useWebAuthnSupport();
  const [isRegistering, setIsRegistering] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => {
    onLoadingChange?.(isRegistering);
  }, [isRegistering, onLoadingChange]);

  const handleSignup = useCallback(async () => {
    if (!csrfToken) {
      toast.error('Please wait for security token to load');
      return;
    }

    if (!email.trim() || !name.trim()) {
      toast.error('Please enter your name and email');
      return;
    }

    if (!email.includes('@') || !email.split('@')[1]?.includes('.')) {
      toast.error('Please enter a valid email address');
      return;
    }

    setIsRegistering(true);

    try {
      // Refresh CSRF token to avoid expiry after sitting on the page
      const freshToken = refreshToken ? (await refreshToken() ?? csrfToken) : csrfToken;

      const platformFields = await getDevicePlatformFields();

      // Get registration options
      const optionsRes = await fetch('/api/auth/signup-passkey/options', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim(),
          csrfToken: freshToken,
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
          email: email.trim(),
          name: name.trim(),
          response: regResponse,
          expectedChallenge: options.challenge,
          csrfToken: freshToken,
          acceptedTos: true,
          ...platformFields,
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

      const verifyData = await verifyRes.json();

      persistCsrfToken();
      useAuthStore.getState().setAuthFailedPermanently(false);

      if (await handleDesktopAuthResponse(verifyData, '/dashboard?welcome=true')) {
        toast.success('Account created successfully!');
        return;
      }

      toast.success('Account created successfully!');

      if (onSuccess) {
        onSuccess(verifyData.redirectUrl);
      } else {
        window.location.href = verifyData.redirectUrl;
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
  }, [csrfToken, refreshToken, email, name, onSuccess, onEmailExists]);

  // Don't render if browser doesn't support WebAuthn
  if (isSupported === false) {
    return null;
  }

  const isButtonDisabled = disabled || isRegistering || isSupported === null;

  return (
    <div className={cn('w-full', className)}>
      <AnimatePresence mode="wait">
        {!isExpanded ? (
          <motion.div
            key="collapsed"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
          >
            <Button
              onClick={() => setIsExpanded(true)}
              disabled={isButtonDisabled}
              className="w-full"
            >
              <Fingerprint className="mr-2 h-4 w-4" />
              Create with Passkey
            </Button>
          </motion.div>
        ) : (
          <motion.div
            key="expanded"
            className="space-y-3"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            transition={{ duration: 0.2 }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="passkey-name">Name</Label>
              <Input
                id="passkey-name"
                name="name"
                autoComplete="name"
                placeholder="John Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isRegistering}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="passkey-email">Email</Label>
              <Input
                id="passkey-email"
                name="email"
                type="email"
                autoComplete="email webauthn"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isRegistering}
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setIsExpanded(false)}
                disabled={isRegistering}
                className="shrink-0"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSignup}
                disabled={isButtonDisabled || !name.trim() || !email.trim()}
                className="flex-1"
              >
                {isRegistering ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating account...
                  </>
                ) : (
                  <>
                    <Fingerprint className="mr-2 h-4 w-4" />
                    Continue
                  </>
                )}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

'use client';

import { useState, useCallback, useEffect } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
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
  /** Pre-fills + disables the email input — used when arriving from /invite/[token]. */
  lockedEmail?: string;
  /** Forwarded to /api/auth/signup-passkey so the server can attach the new user to the invite. */
  inviteToken?: string;
  /** If set, overrides the server redirect after successful registration (e.g. share link return). */
  nextPath?: string;
}

export function PasskeySignupButton({
  csrfToken,
  refreshToken,
  onSuccess,
  onEmailExists,
  onLoadingChange,
  className,
  disabled = false,
  lockedEmail,
  inviteToken,
  nextPath,
}: PasskeySignupButtonProps) {
  const isSupported = useWebAuthnSupport();
  const [isRegistering, setIsRegistering] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState(lockedEmail ?? '');
  const [acceptedTos, setAcceptedTos] = useState(false);

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

    if (!acceptedTos) {
      toast.error('Please agree to the Terms of Service and Privacy Policy');
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
          acceptedTos,
          ...(inviteToken ? { inviteToken } : {}),
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
        onSuccess(nextPath ?? verifyData.redirectUrl);
      } else {
        window.location.href = nextPath ?? verifyData.redirectUrl;
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
  }, [csrfToken, refreshToken, email, name, acceptedTos, inviteToken, nextPath, onSuccess, onEmailExists]);

  // Don't render if browser doesn't support WebAuthn
  if (isSupported === false) {
    return null;
  }

  // The collapsed CTA must NOT block on `acceptedTos` — the ToS checkbox only
  // renders inside the expanded form, so blocking the trigger would make
  // signup unreachable. The submit button (inside the expanded form) gates on
  // `acceptedTos` separately below.
  const isExpandTriggerDisabled =
    disabled || isRegistering || isSupported === null;
  const isSubmitDisabled = isExpandTriggerDisabled || !acceptedTos;

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
              disabled={isExpandTriggerDisabled}
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
                disabled={isRegistering || !!lockedEmail}
              />
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="passkey-tos"
                checked={acceptedTos}
                onCheckedChange={(checked) => setAcceptedTos(checked === true)}
                disabled={isRegistering}
                className="mt-0.5"
              />
              <Label
                htmlFor="passkey-tos"
                className="text-xs font-normal leading-snug text-muted-foreground"
              >
                I agree to PageSpace&apos;s{' '}
                <Link href="/terms" className="underline hover:text-foreground">
                  Terms
                </Link>
                {' '}and{' '}
                <Link href="/privacy" className="underline hover:text-foreground">
                  Privacy Policy
                </Link>
                .
              </Label>
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
                disabled={isSubmitDisabled || !name.trim() || !email.trim()}
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

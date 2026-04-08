'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Mail, ArrowLeft, Loader2, CheckCircle } from 'lucide-react';
import { getDevicePlatformFields } from '@/lib/desktop-auth';

type FormState = 'input' | 'sending' | 'sent' | 'error';

export function MagicLinkForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [email, setEmail] = useState('');
  const [formState, setFormState] = useState<FormState>('input');
  const [error, setError] = useState<string | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);

  // Cooldown timer after successful send
  useEffect(() => {
    if (cooldownSeconds <= 0) return;

    const timer = setInterval(() => {
      setCooldownSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [cooldownSeconds]);

  // Rate limit retry timer
  useEffect(() => {
    if (retryAfterSeconds <= 0) return;

    const timer = setInterval(() => {
      setRetryAfterSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setFormState('input');
          setError(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [retryAfterSeconds]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    if (formState === 'sending') return;
    if (cooldownSeconds > 0) return;

    setFormState('sending');
    setError(null);

    try {
      // Fetch login CSRF token first
      const csrfResponse = await fetch('/api/auth/login-csrf', {
        credentials: 'include',
      });

      if (!csrfResponse.ok) {
        throw new Error('Failed to initialize security token');
      }

      const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

      const platformFields = await getDevicePlatformFields();

      // Send magic link request
      const response = await fetch('/api/auth/magic-link/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Login-CSRF-Token': csrfToken,
        },
        credentials: 'include',
        body: JSON.stringify({ email: email.trim(), ...platformFields }),
      });

      if (response.status === 429) {
        // Rate limited
        const data = (await response.json()) as { retryAfter?: number; message?: string };
        const retryAfter = data.retryAfter || 60;
        setRetryAfterSeconds(retryAfter);
        setFormState('error');
        setError(`Too many requests. Please try again in ${formatSeconds(retryAfter)}.`);
        return;
      }

      if (response.status === 403) {
        // CSRF error
        const data = (await response.json()) as { details?: string; error?: string };
        setFormState('error');
        setError(data.details || 'Security verification failed. Please refresh the page.');
        return;
      }

      if (!response.ok) {
        const data = (await response.json()) as { error?: string; message?: string };
        setFormState('error');
        setError(data.error || 'Failed to send magic link. Please try again.');
        return;
      }

      // Success - show confirmation
      setFormState('sent');
      setCooldownSeconds(60); // 60 second cooldown before allowing resend
      toast.success('Check your email for a sign-in link');
    } catch (err) {
      console.error('Magic link error:', err);
      setFormState('error');
      setError('Network error. Please check your connection and try again.');
    }
  }, [email, formState, cooldownSeconds]);

  const handleResend = useCallback(async () => {
    if (cooldownSeconds > 0) return;
    // Reset to input state and re-trigger form submission
    setFormState('input');
    setError(null);
    // Use setTimeout to ensure state updates before submit
    setTimeout(() => {
      formRef.current?.requestSubmit();
    }, 0);
  }, [cooldownSeconds]);

  const handleReset = useCallback(() => {
    setFormState('input');
    setError(null);
    setEmail('');
    setCooldownSeconds(0);
    setRetryAfterSeconds(0);
  }, []);

  // Sent state - show confirmation
  if (formState === 'sent') {
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="rounded-full bg-green-100 dark:bg-green-900/30 p-3">
            <CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
          </div>
          <div className="text-center">
            <h3 className="font-medium text-lg">Check your email</h3>
            <p className="text-muted-foreground text-sm mt-1">
              We sent a sign-in link to{' '}
              <span className="font-medium text-foreground">{email}</span>
            </p>
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          The link expires in 5 minutes. Check your spam folder if you don&apos;t see it.
        </p>

        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={cooldownSeconds > 0}
            onClick={handleResend}
          >
            {cooldownSeconds > 0 ? (
              `Resend in ${cooldownSeconds}s`
            ) : (
              'Resend link'
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={handleReset}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Try a different email
          </Button>
        </div>
      </div>
    );
  }

  // Input state - show form
  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-2">
        <Label htmlFor="magic-link-email">Email</Label>
        <div className="relative">
          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            id="magic-link-email"
            type="email"
            placeholder="you@example.com"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="pl-10"
            disabled={formState === 'sending'}
            autoComplete="email"
            autoFocus
          />
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-500 dark:text-red-400">
          {error}
          {retryAfterSeconds > 0 && (
            <span className="font-medium ml-1">
              ({formatSeconds(retryAfterSeconds)} remaining)
            </span>
          )}
        </div>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={formState === 'sending' || retryAfterSeconds > 0}
      >
        {formState === 'sending' ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Sending link...</span>
          </div>
        ) : (
          'Email me a sign-in link'
        )}
      </Button>

    </form>
  );
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} second${seconds !== 1 ? 's' : ''}`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (remainingSeconds === 0) {
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

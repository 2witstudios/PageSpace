'use client';

import { useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuthCSRF } from '@/hooks/useAuthCSRF';
import { getDevicePlatformFields, handleDesktopAuthResponse, type DesktopAuthTokens } from '@/lib/desktop-auth';

interface LoginApiResponse {
  error?: string;
  redirectTo?: string;
  redirectUrl?: string;
  desktopTokens?: DesktopAuthTokens;
}

export function PasswordLoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { csrfToken, isLoading: csrfLoading, error: csrfError } = useAuthCSRF();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const platformFields = await getDevicePlatformFields();

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'x-login-csrf-token': csrfToken } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ email, password, ...platformFields }),
      });

      const data: LoginApiResponse = await res.json();

      if (!res.ok) {
        if (res.status === 423) {
          setError('Account locked due to too many failed attempts. Please try again later.');
        } else if (res.status === 429) {
          setError('Too many login attempts. Please wait before trying again.');
        } else {
          setError(data.error || 'Invalid email or password.');
        }
        return;
      }

      if (await handleDesktopAuthResponse(data)) return;

      // Redirect on success (validate to prevent open redirect)
      const redirectTo = data.redirectTo || '/dashboard';
      const isRelative = redirectTo.startsWith('/') && !redirectTo.startsWith('//');
      window.location.href = isRelative ? redirectTo : '/dashboard';
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <motion.form
      onSubmit={handleSubmit}
      className="space-y-4"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2, duration: 0.3 }}
    >
      {(error || csrfError) && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-400">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error || 'Unable to initialize login form. Please refresh the page.'}</span>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          autoFocus
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          placeholder="Enter your password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
      </div>

      <Button type="submit" className="w-full" disabled={isSubmitting || csrfLoading || !csrfToken}>
        {isSubmitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Signing in...
          </>
        ) : (
          'Sign in'
        )}
      </Button>
    </motion.form>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'motion/react';
import { Mail } from 'lucide-react';
import {
  AuthShell,
  AuthDivider,
  OAuthButtons,
  GoogleOneTap,
  PasskeySignupButton,
  MagicLinkForm,
  ExternalAuthWaiting,
} from '@/components/auth';
import { useAuthCSRF } from '@/hooks/useAuthCSRF';
import { useOAuthSignIn } from '@/hooks/useOAuthSignIn';
import type { InviteContextData } from '@/lib/auth/invite-resolver';

interface SignUpClientProps {
  inviteToken?: string;
  inviteContext?: InviteContextData;
  returnUrl?: string;
  atLimit?: boolean;
}

function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: name || undefined }),
      });
      if (res.ok || res.status === 409) {
        setSubmitted(true);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Something went wrong. Please try again.');
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <AuthShell>
        <motion.div
          className="text-center"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
            You&apos;re on the list.
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            We&apos;ll reach out to{' '}
            <span className="font-medium text-gray-900 dark:text-white">{email}</span>{' '}
            when a spot opens up.
          </p>
        </motion.div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <motion.div
        className="mb-8 text-center"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
          We&apos;re at capacity.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Join the waitlist and we&apos;ll let you know when a spot opens up.
        </p>
      </motion.div>

      <motion.form
        onSubmit={handleSubmit}
        className="space-y-3"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15, duration: 0.3 }}
      >
        <input
          type="text"
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          type="email"
          required
          placeholder="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />

        {error && (
          <p className="text-center text-sm text-red-500">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading || !email}
          className="w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
        >
          {loading ? 'Joining…' : 'Join waitlist'}
        </button>
      </motion.form>

      <motion.div
        className="mt-8 text-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.45, duration: 0.3 }}
      >
        <p className="text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link
            href="/auth/signin"
            className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
          >
            Log in
          </Link>
        </p>
      </motion.div>
    </AuthShell>
  );
}

export function SignUpClient({ inviteToken, inviteContext, returnUrl, atLimit }: SignUpClientProps) {
  if (atLimit) {
    return <WaitlistForm />;
  }

  const [error, setError] = useState<string | null>(null);
  const [showMagicLink, setShowMagicLink] = useState(false);
  const router = useRouter();
  const { csrfToken, refreshToken } = useAuthCSRF();
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const {
    handleGoogleSignIn,
    handleAppleSignIn,
    isGoogleLoading,
    isAppleLoading,
    isWaitingForExternalAuth,
    waitingProvider,
    cancelExternalAuth,
  } = useOAuthSignIn({
    onStart: () => setError(null),
    onError: (msg) => setError(msg),
    ...(inviteToken && { inviteToken }),
    ...(returnUrl && { returnUrl }),
  });

  const isAnyLoading = isGoogleLoading || isAppleLoading || passkeyLoading;

  return (
    <AuthShell>
      <GoogleOneTap
        autoSelect={true}
        cancelOnTapOutside={true}
        context="signup"
        {...(inviteToken && { inviteToken })}
      />

      {inviteContext && (
        <motion.div
          className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm dark:border-blue-900 dark:bg-blue-950/40"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <p className="text-gray-900 dark:text-gray-100">
            {inviteContext.kind === 'connection' ? (
              <>
                <span className="font-semibold">{inviteContext.inviterName}</span>
                {' '}wants to connect with you on PageSpace.
              </>
            ) : (
              <>
                You&apos;re joining{' '}
                <span className="font-semibold text-blue-700 dark:text-blue-300">
                  {inviteContext.driveName}
                </span>
                , invited by{' '}
                <span className="font-semibold">{inviteContext.inviterName}</span>.
              </>
            )}
          </p>
        </motion.div>
      )}

      <motion.div
        className="mb-8 text-center"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
          Get on the same page.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Create your free workspace in seconds
        </p>
      </motion.div>

      {error && (
        <motion.p
          className="mb-4 text-center text-sm text-red-500"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          {error}
        </motion.p>
      )}

      {csrfToken && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.3 }}
        >
          <PasskeySignupButton
            csrfToken={csrfToken}
            refreshToken={refreshToken}
            onEmailExists={() => {
              router.push(returnUrl ? `/auth/signin?next=${encodeURIComponent(returnUrl)}` : '/auth/signin');
            }}
            onLoadingChange={setPasskeyLoading}
            disabled={isAnyLoading}
            inviteToken={inviteToken}
            lockedEmail={inviteContext?.email}
            {...(returnUrl && { nextPath: returnUrl })}
          />
        </motion.div>
      )}

      <AuthDivider delay={0.3} />

      {isWaitingForExternalAuth ? (
        <ExternalAuthWaiting provider={waitingProvider} onCancel={cancelExternalAuth} />
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.3 }}
        >
          <OAuthButtons
            onGoogleClick={handleGoogleSignIn}
            onAppleClick={handleAppleSignIn}
            disabled={isAnyLoading}
            isGoogleLoading={isGoogleLoading}
            isAppleLoading={isAppleLoading}
          />
        </motion.div>
      )}

      <motion.div
        className="mt-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.45, duration: 0.3 }}
      >
        {showMagicLink ? (
          <div id="magic-link-form" className="mt-2">
            <MagicLinkForm {...(inviteToken && { inviteToken })} {...(returnUrl && { nextPath: returnUrl })} />
          </div>
        ) : (
          <button
            type="button"
            aria-expanded={showMagicLink}
            aria-controls="magic-link-form"
            className="flex w-full items-center justify-center gap-2 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setShowMagicLink(true)}
          >
            <Mail className="h-4 w-4" />
            Or sign up with email link
          </button>
        )}
      </motion.div>

      <motion.div
        className="mt-8 text-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.55, duration: 0.3 }}
      >
        <p className="text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link
            href={returnUrl ? `/auth/signin?next=${encodeURIComponent(returnUrl)}` : '/auth/signin'}
            className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
          >
            Log in
          </Link>
        </p>
      </motion.div>
    </AuthShell>
  );
}

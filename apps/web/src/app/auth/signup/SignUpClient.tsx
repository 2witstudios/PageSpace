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
}

export function SignUpClient({ inviteToken, inviteContext, returnUrl }: SignUpClientProps) {
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

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "motion/react";
import { Mail } from "lucide-react";
import {
  AuthShell,
  AuthDivider,
  OAuthButtons,
  GoogleOneTap,
  PasskeySignupButton,
  ExternalAuthWaiting,
} from "@/components/auth";
import { useAuthCSRF } from "@/hooks/useAuthCSRF";
import { useOAuthSignIn } from "@/hooks/useOAuthSignIn";
import { isOnPrem } from "@/lib/deployment-mode";

export default function SignUp() {
  // On-prem: redirect to signin (self-registration disabled) - early return to avoid flash
  if (isOnPrem()) {
    return <OnPremSignUpRedirect />;
  }

  return <CloudSignUp />;
}

function OnPremSignUpRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/auth/signin?onprem=contact_admin");
  }, [router]);
  return null;
}

function CloudSignUp() {
  const [error, setError] = useState<string | null>(null);
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
    });

  const isAnyLoading = isGoogleLoading || isAppleLoading || passkeyLoading;

  return (
    <AuthShell>
      <GoogleOneTap autoSelect={true} cancelOnTapOutside={true} context="signup" />

      {/* Heading */}
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

      {/* Passkey signup */}
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
              router.push("/auth/signin");
            }}
            onLoadingChange={setPasskeyLoading}
            disabled={isAnyLoading}
          />
        </motion.div>
      )}

      <AuthDivider delay={0.3} />

      {/* OAuth buttons */}
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

      {/* Magic link fallback */}
      <motion.div
        className="mt-4 text-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.45, duration: 0.3 }}
      >
        <Link
          href="/auth/magic-link"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <Mail className="h-3.5 w-3.5" />
          Or sign up with email link
        </Link>
      </motion.div>

      {/* Footer */}
      <motion.div
        className="mt-8 text-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.55, duration: 0.3 }}
      >
        <p className="text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            href="/auth/signin"
            className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
          >
            Log in
          </Link>
        </p>
      </motion.div>

      <motion.p
        className="mt-4 text-center text-xs text-muted-foreground/70"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6, duration: 0.3 }}
      >
        By signing up, you agree to our{" "}
        <Link href="/terms" className="underline hover:text-muted-foreground">
          Terms
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="underline hover:text-muted-foreground">
          Privacy Policy
        </Link>
      </motion.p>
    </AuthShell>
  );
}

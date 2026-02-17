"use client";

import { useSearchParams } from "next/navigation";
import { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { motion } from "motion/react";
import { Mail } from "lucide-react";
import {
  AuthShell,
  AuthDivider,
  OAuthButtons,
  GoogleOneTap,
  MagicLinkForm,
  PasskeyLoginButton,
} from "@/components/auth";
import { useLoginCSRF } from "@/hooks/useLoginCSRF";
import { useOAuthSignIn } from "@/hooks/useOAuthSignIn";

function SignInForm() {
  const [showMagicLink, setShowMagicLink] = useState(false);
  const searchParams = useSearchParams();
  const { csrfToken, refreshToken } = useLoginCSRF();
  const { handleGoogleSignIn, handleAppleSignIn, isGoogleLoading, isAppleLoading } =
    useOAuthSignIn();

  useEffect(() => {
    const error = searchParams.get("error");
    const newAccount = searchParams.get("newAccount");

    if (newAccount) {
      toast.info(
        "Your account was created successfully! Please sign in to continue."
      );
    }

    if (error) {
      switch (error) {
        case "access_denied":
          toast.error(
            "Google sign-in was cancelled. Please try again if you want to continue."
          );
          break;
        case "oauth_error":
          toast.error("Google sign-in failed. Please try again.");
          break;
        case "rate_limit":
          toast.error("Too many login attempts. Please try again later.");
          break;
        case "invalid_request":
          toast.error("Invalid request. Please try again.");
          break;
        case "magic_link_expired":
          toast.error(
            "Your sign-in link has expired. Please request a new one."
          );
          break;
        case "magic_link_used":
          toast.error(
            "This sign-in link has already been used. Please request a new one."
          );
          break;
        case "account_suspended":
          toast.error(
            "Your account has been suspended. Please contact support."
          );
          break;
        case "invalid_token":
          toast.error("Invalid sign-in link. Please request a new one.");
          break;
        default:
          toast.error("An error occurred during sign-in.");
      }
    }
  }, [searchParams]);

  return (
    <AuthShell>
      <GoogleOneTap
        onSuccess={() => {}}
        onError={(error) => {
          console.error("Google One Tap error:", error);
        }}
        autoSelect={true}
        cancelOnTapOutside={true}
        context="signin"
      />

      {/* Heading */}
      <motion.div
        className="mb-8 text-center"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
          Welcome back
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in to your workspace
        </p>
      </motion.div>

      {/* OAuth buttons */}
      <OAuthButtons
        onGoogleClick={handleGoogleSignIn}
        onAppleClick={handleAppleSignIn}
        disabled={isGoogleLoading || isAppleLoading}
        isGoogleLoading={isGoogleLoading}
        isAppleLoading={isAppleLoading}
      />

      <AuthDivider delay={0.3} />

      {/* Passkey login */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35, duration: 0.3 }}
      >
        {csrfToken && (
          <PasskeyLoginButton
            csrfToken={csrfToken}
            refreshToken={refreshToken}
            variant="outline"
          />
        )}
      </motion.div>

      {/* Magic link toggle */}
      <motion.div
        className="mt-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.45, duration: 0.3 }}
      >
        {showMagicLink ? (
          <div className="mt-2">
            <MagicLinkForm />
          </div>
        ) : (
          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setShowMagicLink(true)}
          >
            <Mail className="h-4 w-4" />
            Or use a magic link
          </button>
        )}
      </motion.div>

      {/* Footer */}
      <motion.div
        className="mt-8 text-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.55, duration: 0.3 }}
      >
        <p className="text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link
            href="/auth/signup"
            className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
          >
            Sign up
          </Link>
        </p>
      </motion.div>

      <motion.p
        className="mt-4 text-center text-xs text-muted-foreground/70"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6, duration: 0.3 }}
      >
        By signing in, you agree to our{" "}
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

export default function SignIn() {
  return (
    <Suspense
      fallback={
        <AuthShell>
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
              Welcome back
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">Loading...</p>
          </div>
        </AuthShell>
      }
    >
      <SignInForm />
    </Suspense>
  );
}

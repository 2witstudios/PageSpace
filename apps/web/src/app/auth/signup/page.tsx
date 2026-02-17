"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion } from "motion/react";
import { Mail } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AuthShell,
  AuthDivider,
  OAuthButtons,
  GoogleOneTap,
  PasskeySignupButton,
} from "@/components/auth";
import { useLoginCSRF } from "@/hooks/useLoginCSRF";
import { useOAuthSignIn } from "@/hooks/useOAuthSignIn";

export default function SignUp() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [acceptedTos, setAcceptedTos] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { csrfToken } = useLoginCSRF();
  const { handleGoogleSignIn, handleAppleSignIn, isGoogleLoading, isAppleLoading } =
    useOAuthSignIn({
      onStart: () => setError(null),
      onError: (msg) => setError(msg),
    });

  const isAnyLoading = isGoogleLoading || isAppleLoading;

  return (
    <AuthShell>
      <GoogleOneTap
        onSuccess={() => {}}
        onError={(error) => {
          console.error("Google One Tap error:", error);
        }}
        autoSelect={true}
        cancelOnTapOutside={true}
        context="signup"
      />

      {/* Heading */}
      <motion.div
        className="mb-8 text-center"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
          Get on the same Page.
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Create your free workspace in seconds
        </p>
      </motion.div>

      {/* Name + Email fields */}
      <motion.div
        className="space-y-3"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05, duration: 0.3 }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            name="name"
            autoComplete="name"
            placeholder="John Doe"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isAnyLoading}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email webauthn"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isAnyLoading}
          />
        </div>
      </motion.div>

      {/* Terms of Service */}
      <motion.div
        className="mt-4 flex items-start gap-2"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.1, duration: 0.3 }}
      >
        <input
          type="checkbox"
          id="acceptedTos"
          checked={acceptedTos}
          onChange={(e) => setAcceptedTos(e.target.checked)}
          className="mt-1 h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
          disabled={isAnyLoading}
        />
        <label
          htmlFor="acceptedTos"
          className="text-sm text-muted-foreground"
        >
          I agree to the{" "}
          <Link
            href="/terms"
            target="_blank"
            className="underline hover:text-foreground"
          >
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link
            href="/privacy"
            target="_blank"
            className="underline hover:text-foreground"
          >
            Privacy Policy
          </Link>
        </label>
      </motion.div>

      {error && (
        <motion.p
          className="mt-3 text-sm text-red-500"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          {error}
        </motion.p>
      )}

      {/* OAuth buttons */}
      <div className="mt-6">
        <OAuthButtons
          onGoogleClick={handleGoogleSignIn}
          onAppleClick={handleAppleSignIn}
          disabled={isAnyLoading}
          isGoogleLoading={isGoogleLoading}
          isAppleLoading={isAppleLoading}
        />
      </div>

      <AuthDivider delay={0.3} />

      {/* Passkey signup */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35, duration: 0.3 }}
      >
        {csrfToken && (
          <PasskeySignupButton
            csrfToken={csrfToken}
            email={email}
            name={name}
            acceptedTos={acceptedTos}
            onSuccess={(redirectUrl) => {
              router.replace(redirectUrl);
            }}
            onEmailExists={() => {
              router.push("/auth/signin");
            }}
            disabled={isAnyLoading}
          />
        )}
      </motion.div>

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
    </AuthShell>
  );
}

"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { AuthShell } from "@/components/auth/AuthShell";
import { OAuthButton } from "@/components/auth/OAuthButton";
import { AuthDivider } from "@/components/auth/AuthDivider";
import { PasskeySection } from "@/components/auth/PasskeySection";

const ease = [0.25, 0.46, 0.45, 0.94] as const;

export function SignupContent() {
  return (
    <AuthShell>
      <div className="flex flex-col gap-6">
        {/* Header */}
        <div>
          <motion.h1
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.05, ease }}
            className="text-3xl font-bold tracking-tight text-center"
          >
            Get on the same Page.
          </motion.h1>
          <motion.p
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.1, ease }}
            className="mt-2 text-muted-foreground text-center"
          >
            Create your free workspace in seconds
          </motion.p>
        </div>

        {/* OAuth buttons */}
        <div className="flex flex-col gap-3">
          <OAuthButton provider="google" delay={0.15} />
          <OAuthButton provider="apple" delay={0.2} />
        </div>

        {/* Divider */}
        <AuthDivider delay={0.25} />

        {/* Passkey / magic link */}
        <PasskeySection delay={0.3} />

        {/* Footer link */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.4, ease }}
          className="text-center text-sm text-muted-foreground"
        >
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-foreground hover:text-blue-500 transition-colors"
          >
            Log in
          </Link>
        </motion.p>

        {/* Terms */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.45, ease }}
          className="text-center text-xs text-muted-foreground/60"
        >
          By continuing, you agree to our{" "}
          <span className="underline underline-offset-2 hover:text-muted-foreground transition-colors cursor-pointer">Terms</span>
          {" "}and{" "}
          <span className="underline underline-offset-2 hover:text-muted-foreground transition-colors cursor-pointer">Privacy Policy</span>.
        </motion.p>
      </div>
    </AuthShell>
  );
}

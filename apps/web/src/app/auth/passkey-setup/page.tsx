"use client";

import { Suspense, useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Fingerprint, Key, Loader2 } from "lucide-react";
import { AuthShell, useWebAuthnSupport } from "@/components/auth";
import { Button } from "@/components/ui/button";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
import { isDesktopPlatform } from "@/lib/desktop-auth";
import { isSafeNextPath, SIGNIN_NEXT_ALLOWED_PREFIXES } from "@/lib/auth/url-utils";

/**
 * First-run passkey enrollment. On-prem users arrive here right after their
 * first sign-in via an admin-issued setup link (see the magic-link verify
 * route), because on-prem has no password and no email delivery — a passkey is
 * how they secure the account for future logins. Enrollment is encouraged but
 * skippable so a user is never hard-blocked out of their own workspace.
 */
function PasskeySetupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isSupported = useWebAuthnSupport();
  const [isRegistering, setIsRegistering] = useState(false);

  const rawNext = searchParams.get("next");
  const nextPath =
    rawNext && isSafeNextPath({ path: rawNext, allowedPrefixes: SIGNIN_NEXT_ALLOWED_PREFIXES })
      ? rawNext
      : "/dashboard";

  const goNext = useCallback(() => {
    router.replace(nextPath);
  }, [router, nextPath]);

  const handleRegister = useCallback(async () => {
    // Electron's embedded Chromium can't drive platform authenticators without
    // entitlements we don't ship — the desktop passkey flow lives in Settings
    // (handoff to the system browser). Don't attempt the ceremony here.
    if (isDesktopPlatform()) {
      toast.info("Add a passkey from Settings → Account after signing in.");
      goNext();
      return;
    }

    setIsRegistering(true);
    try {
      const optionsRes = await fetchWithAuth("/api/auth/passkey/register/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!optionsRes.ok) {
        const err = await optionsRes.json().catch(() => ({}));
        toast.error(err.error || "Failed to start passkey registration");
        return;
      }

      const { options } = await optionsRes.json();
      const registrationResponse = await startRegistration({ optionsJSON: options });

      const verifyRes = await fetchWithAuth("/api/auth/passkey/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response: registrationResponse,
          expectedChallenge: options.challenge,
        }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        toast.error(err.error || "Failed to register passkey");
        return;
      }

      toast.success("Passkey registered");
      goNext();
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        toast.error("Registration was cancelled");
      } else if (err instanceof Error && err.name === "InvalidStateError") {
        toast.error("This passkey is already registered");
      } else {
        toast.error("Passkey registration failed");
      }
    } finally {
      setIsRegistering(false);
    }
  }, [goNext]);

  return (
    <AuthShell>
      <motion.div
        className="mb-8 text-center"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Fingerprint className="h-6 w-6 text-muted-foreground" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
          Secure your account
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Register a passkey to sign in with your device&apos;s fingerprint, face,
          or security key. This is how you&apos;ll log in from now on.
        </p>
      </motion.div>

      {isSupported === false ? (
        <div className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">
            This browser doesn&apos;t support passkeys. Continue for now and add a
            passkey later from Settings → Account on a supported device.
          </p>
          <Button onClick={goNext} className="w-full">
            Continue
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Button
            onClick={handleRegister}
            disabled={isRegistering || isSupported === null}
            className="w-full"
          >
            {isRegistering ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Registering...
              </>
            ) : (
              <>
                <Key className="mr-2 h-4 w-4" />
                Register a passkey
              </>
            )}
          </Button>
          <button
            type="button"
            onClick={goNext}
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
          >
            Skip for now
          </button>
        </div>
      )}
    </AuthShell>
  );
}

export default function PasskeySetupPage() {
  return (
    <Suspense fallback={null}>
      <PasskeySetupForm />
    </Suspense>
  );
}

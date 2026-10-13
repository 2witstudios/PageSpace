"use client";

import { useSearchParams } from "next/navigation";
import { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { MarketingLink } from '@/components/ui/MarketingLink';
import { toast } from "sonner";
import { motion } from "motion/react";
import { Mail } from "lucide-react";
import {
  AuthLayout,
  AuthDivider,
  OAuthButtons,
  GoogleOneTap,
  MagicLinkForm,
  PasskeyLoginButton,
  ExternalAuthWaiting,
} from "@/components/auth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useAuthCSRF } from "@/hooks/useAuthCSRF";
import { useOAuthSignIn } from "@/hooks/useOAuthSignIn";
import { isOnPrem } from "@/lib/deployment-mode";
import { resolveSigninNext } from "@/lib/auth/resolve-signin-next";
import { getPreferredBrowserName } from "@/lib/auth/browser-detection";
import { useConsentStore } from "@/stores/useConsentStore";
import { useInAppBrowserNotice } from "@/hooks/useInAppBrowserNotice";
import { isImagoEnabled } from "@/lib/imago/imago-enabled";
import { AuthStatusPill } from "@/components/auth/AuthStatusPill";
import { useSigninRecovery } from "./useSigninRecovery";
import { signinErrorNotice, signinPillNotice } from "./signin-errors";

// v3 (Imago-enabled) look. Only read when isImagoEnabled(); the classic markup keeps its own classes.
const V3_PRIMARY_BUTTON =
  "h-10 rounded-[10px] bg-[oklch(0.50_0.16_235)] text-[oklch(0.98_0.005_235)] shadow-none hover:bg-[oklch(0.46_0.16_235)]";
const V3_LINK = "font-medium text-[oklch(0.50_0.16_235)] hover:text-[oklch(0.42_0.16_235)]";

function headingClass(imago: boolean): string {
  return imago
    ? "text-[28px] font-bold leading-[1.15] tracking-[-0.02em] text-left text-[oklch(0.15_0.01_220)]"
    : "text-3xl font-bold tracking-tight text-gray-900 dark:text-white";
}

function subtitleClass(imago: boolean): string {
  return imago ? "mt-2 text-sm text-[oklch(0.48_0.015_220)]" : "mt-2 text-sm text-muted-foreground";
}

// Shared loading shell: the Suspense fallback (searchParams boundary) and the in-flight
// silent-recovery state render the same minimal screen, so users never see it change shape.
function AuthLoading() {
  const imago = isImagoEnabled();
  return (
    <AuthLayout>
      <div className={imago ? "text-left" : "text-center"}>
        <h1 className={headingClass(imago)}>
          Welcome back
        </h1>
        <p className={subtitleClass(imago)}>Loading...</p>
      </div>
    </AuthLayout>
  );
}

function SignInForm() {
  const [showMagicLink, setShowMagicLink] = useState(false);
  const inAppInfo = useInAppBrowserNotice();
  const reopenBanner = useConsentStore((s) => s.reopenBanner);
  const searchParams = useSearchParams();
  const { csrfToken, refreshToken } = useAuthCSRF();
  const inviteToken = searchParams.get('invite') ?? undefined;

  // Logged-out /dashboard requests reach this page via a middleware REWRITE (see
  // resolveSigninNext), so the deep link lives in the browser path, not in `next=`.
  // Read post-mount: window is browser-only.
  const [browserPath, setBrowserPath] = useState<string | null>(null);
  useEffect(() => {
    setBrowserPath(`${window.location.pathname}${window.location.search}`);
  }, []);

  const nextPath = resolveSigninNext({ paramNext: searchParams.get('next'), browserPath });

  // Silent session recovery: before showing the form, try to heal the session (live cookie
  // → redirect; expired cookie + device token → refresh → redirect). This restores the
  // recovery the 2026-07-07 middleware change defeated. See ./signin-recovery.ts.
  //
  // Gate on `browserPath` being resolved: under a middleware rewrite the deep link lives in
  // the browser URL (read post-mount above), so `nextPath` is undefined on the first render.
  // Starting recovery before then would redirect a recovered user to the default dashboard
  // instead of the page they originally opened.
  const { recovering } = useSigninRecovery(nextPath, browserPath !== null);

  const {
    handleGoogleSignIn,
    handleAppleSignIn,
    isGoogleLoading,
    isAppleLoading,
    isWaitingForExternalAuth,
    waitingProvider,
    cancelExternalAuth,
  } = useOAuthSignIn({
    ...(inviteToken && { inviteToken }),
    ...(nextPath && { returnUrl: nextPath }),
  });
  const onPrem = isOnPrem();
  const imago = isImagoEnabled();
  // v3 shows error and notice params as a status pill; classic shows them as sonner toasts.
  const pill = imago ? signinPillNotice(searchParams) : null;

  useEffect(() => {
    const error = searchParams.get("error");
    const newAccount = searchParams.get("newAccount");
    const onpremMessage = searchParams.get("onprem");
    // v3 renders these as the status pill instead (see `pill` above).
    const imagoFrame = isImagoEnabled();

    if (onpremMessage === "contact_admin" && !imagoFrame) {
      toast.info("Contact your administrator for an account.");
    }

    if (newAccount) {
      toast.info(
        "Your account was created successfully! Please sign in to continue."
      );
    }

    if (error && !imagoFrame) {
      toast.error(signinErrorNotice(error).text);
    }
  }, [searchParams]);

  // A genuine in-app browser cannot complete Google's web OAuth, so open the
  // magic-link form for it. The Capacitor shell never reports in-app (native
  // Google works there), so this leaves the app's sign-in screen alone.
  useEffect(() => {
    if (inAppInfo.isInApp) setShowMagicLink(true);
  }, [inAppInfo.isInApp]);

  // While silent recovery is in flight, show a minimal loading state rather than the form,
  // so a user who is about to be auto-redirected never sees the form flash.
  if (recovering) {
    return <AuthLoading />;
  }

  // On-prem: passkey + magic link sign-in (no OAuth)
  if (onPrem) {
    return (
      <AuthLayout>
        {pill && <AuthStatusPill tone={pill.tone}>{pill.text}</AuthStatusPill>}
        <motion.div
          className={imago ? "mb-8 text-left" : "mb-8 text-center"}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1 className={headingClass(imago)}>
            Welcome back
          </h1>
          <p className={subtitleClass(imago)}>
            Sign in to your workspace
          </p>
        </motion.div>

        {csrfToken && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.3 }}
          >
            <PasskeyLoginButton
              csrfToken={csrfToken}
              refreshToken={refreshToken}
              {...(nextPath && { nextPath })}
              {...(inviteToken && { inviteToken })}
              {...(imago && { className: V3_PRIMARY_BUTTON })}
            />
          </motion.div>
        )}

        {/* On-prem has no outbound email and no self-registration, so magic-link
            sign-in can't be delivered. Passkeys are the only credential; a new
            user's first passkey is enrolled from a one-time admin-issued setup
            link (see the admin user-creation flow). */}
        <p className="mt-6 text-center text-sm text-muted-foreground">
          No passkey yet? Ask your administrator for a one-time setup link.
        </p>
      </AuthLayout>
    );
  }

  const browserName = getPreferredBrowserName() ?? 'your browser';
  const appLabel = inAppInfo.appName ?? 'this app';

  // Classic: the warning sits above the heading. v3 (board): it sits under the heading.
  const inAppAlert = inAppInfo.isInApp ? (
    imago ? (
      <div
        role="alert"
        className="mt-5 rounded-[10px] border border-[oklch(0.70_0.17_50/0.30)] bg-[oklch(0.70_0.17_50/0.10)] px-3.5 py-3 text-[13px] leading-normal text-[oklch(0.40_0.10_50)]"
      >
        <div className="font-semibold">Google sign-in is blocked in {appLabel}</div>
        <div>Use a magic link below, or open this page in {browserName} to sign in with Google.</div>
      </div>
    ) : (
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="mb-6"
      >
        <Alert variant="warning">
          <AlertTitle>Google sign-in is blocked in {appLabel}</AlertTitle>
          <AlertDescription>
            Use a magic link below, or open this page in {browserName} to sign in with Google.
          </AlertDescription>
        </Alert>
      </motion.div>
    )
  ) : null;

  return (
    <AuthLayout>
      <GoogleOneTap
        autoSelect={false}
        cancelOnTapOutside={true}
        context="signin"
        {...(inviteToken && { inviteToken })}
      />

      {pill && <AuthStatusPill tone={pill.tone}>{pill.text}</AuthStatusPill>}

      {!imago && inAppAlert}

      {/* Heading */}
      <motion.div
        className={imago ? "mb-7 text-left" : "mb-8 text-center"}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <h1 className={headingClass(imago)}>
          Welcome back
        </h1>
        <p className={subtitleClass(imago)}>
          Sign in to your workspace
        </p>
        {imago && inAppAlert}
      </motion.div>

      {/* Passkey login */}
      {csrfToken && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.3 }}
        >
          <PasskeyLoginButton
            csrfToken={csrfToken}
            refreshToken={refreshToken}
            {...(nextPath && { nextPath })}
            {...(inviteToken && { inviteToken })}
            {...(imago && { className: V3_PRIMARY_BUTTON })}
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
            disabled={isGoogleLoading || isAppleLoading}
            isGoogleLoading={isGoogleLoading}
            isAppleLoading={isAppleLoading}
            variant={imago ? "v3" : "default"}
          />
        </motion.div>
      )}

      {/* Magic link toggle */}
      <motion.div
        className="mt-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.45, duration: 0.3 }}
      >
        {showMagicLink ? (
          <div className="mt-2">
            <MagicLinkForm
              {...(nextPath && { nextPath })}
              {...(inviteToken && { inviteToken })}
            />
          </div>
        ) : (
          <button
            type="button"
            className={
              imago
                ? "flex h-9 w-full items-center justify-center gap-2 rounded-[10px] text-[13px] text-[oklch(0.48_0.015_220)] transition-colors hover:text-[oklch(0.15_0.01_220)]"
                : "flex w-full items-center justify-center gap-2 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            }
            onClick={() => setShowMagicLink(true)}
          >
            <Mail className="h-4 w-4" />
            Or use a magic link
          </button>
        )}
      </motion.div>

      {/* Footer */}
      <motion.div
        className={imago ? "mt-7 text-left" : "mt-8 text-center"}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.55, duration: 0.3 }}
      >
        <p className={imago ? "text-[13.5px] text-[oklch(0.48_0.015_220)]" : "text-sm text-muted-foreground"}>
          Don&apos;t have an account?{" "}
          <Link
            href={nextPath ? `/auth/signup?next=${encodeURIComponent(nextPath)}` : '/auth/signup'}
            className={imago ? V3_LINK : "font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"}
          >
            Sign up
          </Link>
        </p>
      </motion.div>

      <motion.p
        className={imago ? "mt-[18px] text-left text-[12px] leading-[1.55] text-[oklch(0.60_0.012_220)]" : "mt-4 text-center text-xs text-muted-foreground/70"}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6, duration: 0.3 }}
      >
        By signing in, you agree to our{" "}
        <MarketingLink href="/terms" className="underline hover:text-muted-foreground">
          Terms
        </MarketingLink>{" "}
        and{" "}
        <MarketingLink href="/privacy" className="underline hover:text-muted-foreground">
          Privacy Policy
        </MarketingLink>
        {" · "}
        <button
          type="button"
          className={imago ? "underline hover:text-[oklch(0.15_0.01_220)]" : "underline hover:text-muted-foreground"}
          onClick={reopenBanner}
        >
          Cookie preferences
        </button>
      </motion.p>
    </AuthLayout>
  );
}

export default function SignIn() {
  return (
    <Suspense fallback={<AuthLoading />}>
      <SignInForm />
    </Suspense>
  );
}

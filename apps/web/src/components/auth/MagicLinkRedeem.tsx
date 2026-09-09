'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldAlert } from 'lucide-react';
import { AuthShell } from '@/components/auth/AuthShell';
import { isCapacitorApp } from '@/lib/capacitor-bridge';
import { getPlatformStorage } from '@/lib/auth/platform-storage';

type Status = { kind: 'redeeming' } | { kind: 'redirecting' } | { kind: 'error'; message: string };

/** What `POST /api/auth/magic-link/verify` answers on success. */
interface RedeemResponse {
  redirectTo: string;
  isNewUser: boolean;
  user: {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
    emailVerified: string | null;
  } | null;
  // Present only when this is the device the link was minted for.
  sessionToken?: string;
  csrfToken?: string;
  deviceToken?: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  magic_link_expired: 'This sign-in link has expired. Request a new one to continue.',
  magic_link_used: 'This sign-in link has already been used. Request a new one to continue.',
  account_suspended: 'This account has been suspended.',
  // A failure on our side says nothing about the link. Telling the user it is
  // invalid would send them to request a replacement that fails the same way.
  server_error: 'Something went wrong on our end. Open the link again in a moment.',
  session_error: 'Something went wrong on our end. Open the link again in a moment.',
};

const FALLBACK_MESSAGE = 'This sign-in link is not valid. Request a new one to continue.';

const NETWORK_MESSAGE = 'We could not reach PageSpace to complete sign-in. Check your connection and open the link again.';

/**
 * Redeems a magic link the app was opened with.
 *
 * One same-origin POST does the work: its `Set-Cookie` lands in the WebView's
 * own jar (the whole reason the link comes here instead of Safari), and when
 * the server recognises this device it also returns bearer tokens, stored
 * through the platform's secure store exactly as native Google / Apple
 * sign-in store theirs. Navigation is `router.replace`, never
 * `window.location`: a top-level load outside `/dashboard` reaches
 * Capacitor's navigation delegate and blanks the WebView.
 */
export function MagicLinkRedeem({ token, next }: { token: string; next?: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: 'redeeming' });
  const started = useRef(false);

  useEffect(() => {
    // Once only, and deliberately without an "unmounted" guard around the
    // navigation: the token is single-use, so a second run would spend a token
    // that is already gone, and a run that completed but refused to navigate
    // would strand the user on this page with nothing left to retry. A
    // setState after unmount is a no-op in React 18+, so the worst case if the
    // user does navigate away first is a redirect they asked for a moment ago.
    // The ref survives StrictMode's mount/unmount/mount, which is what keeps
    // the token from being spent twice.
    if (started.current) return;
    started.current = true;

    const run = async () => {
      const native = isCapacitorApp();
      // A secure store that cannot answer is not a reason to fail the sign-in;
      // it only means this request cannot prove which device it is, so it
      // takes the cookie-only path a browser takes.
      let deviceId: string | undefined;
      if (native) {
        try {
          deviceId = await getPlatformStorage().getDeviceId();
        } catch (error) {
          console.warn('[MagicLinkRedeem] could not read the device id', error);
        }
      }

      const response = await fetch('/api/auth/magic-link/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          token,
          ...(next && { next }),
          ...(deviceId && { deviceId }),
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        const code = data.error ?? 'invalid_token';
        setStatus({ kind: 'error', message: ERROR_MESSAGES[code] ?? FALLBACK_MESSAGE });
        // The sign-in page already maps these codes to a toast; landing there
        // also gives the user the form to request a fresh link.
        router.replace(`/auth/signin?error=${encodeURIComponent(code)}`);
        return;
      }

      const data = (await response.json()) as RedeemResponse;

      // The session is already granted at this point — the response set the
      // cookie, and the token is spent. Everything below is about making that
      // session durable in the shell, so a failure degrades the session rather
      // than discarding it: a cookie-only app session works, and the user can
      // sign in again later, where being stranded here leaves them no move at
      // all.
      if (native && deviceId) {
        if (data.sessionToken) {
          try {
            await getPlatformStorage().storeSession({
              sessionToken: data.sessionToken,
              csrfToken: data.csrfToken ?? null,
              deviceId,
              deviceToken: data.deviceToken ?? null,
            });
          } catch (error) {
            console.error('[MagicLinkRedeem] could not store the session', error);
          }
        } else {
          // This device asked for the link and redeemed it, so the server
          // should have recognised it. Reaching here means the device handoff
          // failed server-side; the cookie carries the session until it
          // expires, and there is no stored token to refresh it with.
          console.warn('[MagicLinkRedeem] signed in by cookie only — no tokens for this device');
        }
      }

      const { useAuthStore } = await import('@/stores/useAuthStore');
      useAuthStore.getState().setAuthFailedPermanently(false);
      if (data.user) {
        useAuthStore.getState().setUser({
          id: data.user.id,
          name: data.user.name,
          email: data.user.email,
          image: data.user.image,
          emailVerified: data.user.emailVerified ? new Date(data.user.emailVerified) : null,
        });
      }

      setStatus({ kind: 'redirecting' });
      router.replace(data.redirectTo);
    };

    run().catch((error: unknown) => {
      // Keep the reason in the console, not in the copy: this text is read by
      // someone who just tapped a link, and `TypeError: Failed to fetch` tells
      // them nothing they can act on.
      console.error('[MagicLinkRedeem] redemption failed', error);
      setStatus({ kind: 'error', message: NETWORK_MESSAGE });
    });
  }, [router, token, next]);

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        {status.kind === 'error' ? (
          <>
            <ShieldAlert className="h-8 w-8 text-destructive" />
            <div>
              <p className="text-sm font-medium text-foreground">Sign-in failed</p>
              <p className="mt-1 text-xs text-muted-foreground">{status.message}</p>
            </div>
          </>
        ) : (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              {status.kind === 'redirecting' ? 'Signed in — opening PageSpace…' : 'Signing you in…'}
            </p>
          </>
        )}
      </div>
    </AuthShell>
  );
}

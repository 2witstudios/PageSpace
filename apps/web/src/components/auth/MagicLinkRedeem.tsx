'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldAlert } from 'lucide-react';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { isCapacitorApp } from '@/lib/capacitor-bridge';
import { getPlatformStorage } from '@/lib/auth/platform-storage';

type Status =
  | { kind: 'redeeming' }
  | { kind: 'redirecting' }
  /**
   * Only reachable before the server has seen the token, so every error here
   * is one a retry can clear. Once the response arrives the token is spent and
   * the user is signed in; from that point nothing may show this screen.
   */
  | { kind: 'error'; message: string; retryable: boolean };

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
  server_error: 'Something went wrong on our end. Try again in a moment.',
  session_error: 'Something went wrong on our end. Try again in a moment.',
};

const FALLBACK_MESSAGE = 'This sign-in link is not valid. Request a new one to continue.';

const NETWORK_MESSAGE =
  'We could not reach PageSpace to complete sign-in. Check your connection and try again.';

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

  const redeem = useCallback(async () => {
    const native = isCapacitorApp();
    // A secure store that cannot answer is not a reason to fail the sign-in;
    // it only means this request cannot prove which device it is, so it takes
    // the cookie-only path a browser takes.
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
      // Our fault, so the link itself is still good and trying again can
      // work. Every other code means the link will never work again —
      // spent, expired, or never ours — and only a fresh one will do.
      const retryable = code === 'server_error' || code === 'session_error';
      setStatus({ kind: 'error', message: ERROR_MESSAGES[code] ?? FALLBACK_MESSAGE, retryable });
      if (retryable) return;
      // The sign-in page already maps these codes to a toast; landing there
      // also gives the user the form to request a fresh link.
      router.replace(`/auth/signin?error=${encodeURIComponent(code)}`);
      return;
    }

    // THE USER IS SIGNED IN FROM HERE ON. The response set the session cookie
    // and the token is spent, so nothing below may fail the sign-in: every
    // step is best-effort, and the function ends in a navigation either way.
    // Letting a failure here reach the caller's catch would show "sign-in
    // failed" with a retry, to someone who is signed in, for a token that no
    // retry can spend again.
    let data: RedeemResponse | null = null;
    try {
      data = (await response.json()) as RedeemResponse;
    } catch (error) {
      console.error('[MagicLinkRedeem] could not read the success response', error);
    }

    if (native) {
      const storage = getPlatformStorage();
      try {
        if (deviceId && data?.sessionToken) {
          await storage.storeSession({
            sessionToken: data.sessionToken,
            csrfToken: data.csrfToken ?? null,
            deviceId,
            deviceToken: data.deviceToken ?? null,
          });
        } else {
          // No tokens for this device: either it could not name itself (the
          // device id was unreadable), the link was never bound to it, or the
          // server's handoff failed. In all three the server has just revoked
          // this device's sessions, so anything still stored is stale.
          console.warn('[MagicLinkRedeem] no tokens for this device; falling back to the cookie');
          await storage.clearSession();
        }
      } catch (error) {
        // Never leave the old entry behind. The server has already revoked
        // this device's previous sessions (and, where it minted, rotated its
        // device token), so a stale bearer is not merely useless:
        // `auth-fetch` prefers a stored bearer over the cookie, and the
        // server rejects an invalid bearer outright rather than falling back
        // — which would turn the valid cookie session we just received into
        // 401s.
        console.error('[MagicLinkRedeem] could not store the session; clearing the stale one', error);
        await getPlatformStorage()
          .clearSession()
          .catch((clearError: unknown) => {
            console.error('[MagicLinkRedeem] could not clear the stale session either', clearError);
          });
      }
    }

    // Priming the store is a convenience — the dashboard reloads it anyway —
    // so a chunk that will not load must not strand a signed-in user here.
    try {
      const { useAuthStore } = await import('@/stores/useAuthStore');
      useAuthStore.getState().setAuthFailedPermanently(false);
      if (data?.user) {
        useAuthStore.getState().setUser({
          id: data.user.id,
          name: data.user.name,
          email: data.user.email,
          image: data.user.image,
          emailVerified: data.user.emailVerified ? new Date(data.user.emailVerified) : null,
        });
      }
    } catch (error) {
      console.error('[MagicLinkRedeem] could not prime the auth store', error);
    }

    setStatus({ kind: 'redirecting' });
    // Without a readable body we cannot know where they were headed, but they
    // are signed in, so the dashboard is the right place to land.
    router.replace(data?.redirectTo ?? '/dashboard');
  }, [router, token, next]);

  const run = useCallback(() => {
    setStatus({ kind: 'redeeming' });
    redeem().catch((error: unknown) => {
      // Everything after the response is handled inside `redeem`, because by
      // then the user is signed in — so what reaches here is a request that
      // never completed, the token was never spent, and offering a retry is
      // honest. (The one exception is `router.replace` itself throwing, which
      // would mean navigation is broken and no message helps.) The reason
      // stays in the console: `TypeError: Failed to fetch` tells the person
      // who just tapped a link nothing they can act on.
      console.error('[MagicLinkRedeem] redemption failed', error);
      setStatus({ kind: 'error', message: NETWORK_MESSAGE, retryable: true });
    });
  }, [redeem]);

  useEffect(() => {
    // Once only: the token is single-use, so a second automatic run would
    // spend a token that is already gone. The ref survives StrictMode's
    // mount/unmount/mount, which is what makes that true. Deliberately no
    // "unmounted" guard around the navigation — a run that completed but
    // refused to navigate would strand the user on this page, and a setState
    // after unmount is a no-op in React 18+.
    if (started.current) return;
    started.current = true;
    run();
  }, [run]);

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
            {/* The retry has to live here: `DeepLinkHandler` drops a repeat of
                the URL it just handled, so re-tapping the same link does
                nothing, and the user would otherwise have to restart the app
                or ask for another link for a token that was never spent. */}
            {status.retryable && (
              <Button type="button" variant="outline" size="sm" onClick={run}>
                Try again
              </Button>
            )}
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

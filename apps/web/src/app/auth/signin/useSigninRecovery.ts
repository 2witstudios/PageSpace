'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { refreshAuthSession } from '@/lib/auth/auth-fetch';
import { isCapacitorApp } from '@/lib/capacitor-bridge';
import { useAuthStore } from '@/stores/useAuthStore';
import { decideSigninRecovery, type SigninRecoveryInput } from './signin-recovery';

const DEFAULT_NEXT = '/dashboard';

function detectNativeShell(): boolean {
  if (typeof window === 'undefined') return false;
  return !!window.electron?.isDesktop || isCapacitorApp();
}

function hasDeviceToken(): boolean {
  return typeof localStorage !== 'undefined' && !!localStorage.getItem('deviceToken');
}

async function checkMeAuthenticated(): Promise<boolean> {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'include' });
    return response.ok;
  } catch {
    // Network error — treat as unauthenticated and fall through to the device-token path.
    return false;
  }
}

/**
 * Imperative shell for silent session recovery on the signin page.
 *
 * Runs the effects — GET /api/auth/me, reading the device token, the AuthFetch refresh,
 * the router navigation — and defers every decision to the pure `decideSigninRecovery`
 * core. See ./signin-recovery.ts for why this exists (the 2026-07-07 middleware change
 * that started bouncing recoverable sessions to the signin form).
 *
 * Returns `recovering`: while true, the page shows a minimal loading state instead of the
 * form, so a user who is about to be redirected never sees the form flash. It flips to
 * false only when recovery lands on the form (or is skipped in a native shell); on a
 * redirect it stays true through the navigation.
 *
 * READINESS. Recovery must not begin until `ready` is true. The signin page resolves the
 * post-recovery destination (`nextPath`) from the browser URL in a mount effect, so on the
 * very first render it is not yet known — for a middleware *rewrite* (the iOS/deep-link
 * flow, see resolve-signin-next.ts) `nextPath` is `undefined` until that effect runs.
 * Starting earlier would capture the unresolved destination and silently redirect a
 * recovered user to `/dashboard` instead of the page they originally opened. Gating on
 * `ready` guarantees the destination is resolved before the one-shot recovery starts.
 *
 * STRICTMODE. The effect keys on `ready` (not a persisted ref), so it is safe under React
 * StrictMode's dev mount probe: the `cancelled` cleanup aborts the discarded first run and
 * the re-run starts fresh, rather than a ref latching `true` and stranding the page on the
 * loading state. Recovery still runs once per real mount because `ready` flips false→true
 * exactly once (`browserPath` is set a single time).
 */
export function useSigninRecovery(
  nextPath: string | undefined,
  ready: boolean,
): { recovering: boolean } {
  const router = useRouter();
  const [recovering, setRecovering] = useState(true);

  useEffect(() => {
    if (!ready) return;

    let cancelled = false;

    const run = async () => {
      const observed: SigninRecoveryInput = {
        isNativeShell: detectNativeShell(),
        // Read fresh from the store rather than subscribing: this effect runs once and must
        // see the flag's value when recovery starts, not restart when it later changes.
        authFailedPermanently: useAuthStore.getState().authFailedPermanently,
        meAuthenticated: undefined,
        hasDeviceToken: hasDeviceToken(),
        refreshSucceeded: undefined,
      };

      // Drive the pure machine: perform each action, feed the result back, repeat until
      // a terminal action. The machine never loops back to an earlier step, and every
      // effect below is a strictly-forward observation, so this cannot spin.
      for (;;) {
        if (cancelled) return;
        const action = decideSigninRecovery(observed);

        switch (action.type) {
          case 'skip':
          case 'show-form':
            if (!cancelled) setRecovering(false);
            return;

          case 'redirect':
            // Keep `recovering` true through the navigation so the form never flashes.
            router.replace(nextPath ?? DEFAULT_NEXT);
            return;

          case 'check-me':
            observed.meAuthenticated = await checkMeAuthenticated();
            break;

          case 'refresh': {
            const result = await refreshAuthSession();
            observed.refreshSucceeded = result.success;
            break;
          }
        }
      }
    };

    // Fail open: recovery is best-effort, so an unexpected rejection anywhere in the driver
    // must fall back to showing the form — never strand the page on the loading state (this
    // is the app's primary auth entry point). `refreshAuthSession` resolves a result today,
    // but its type makes no never-throw guarantee, and neither does a dynamic import inside it.
    void run().catch(() => {
      if (!cancelled) setRecovering(false);
    });

    return () => {
      cancelled = true;
    };
    // Starts once, when `ready` flips true; `nextPath` is fully resolved by then and stable
    // thereafter (browserPath is set a single time), so it is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return { recovering };
}

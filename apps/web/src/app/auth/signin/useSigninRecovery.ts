'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { refreshAuthSession } from '@/lib/auth/auth-fetch';
import { isCapacitorApp } from '@/lib/capacitor-bridge';
import { useAuthStore } from '@/stores/useAuthStore';
import { decideSigninRecovery, type SigninRecoveryInput } from './signin-recovery';

const DEFAULT_NEXT = '/dashboard';

function isNativeShell(): boolean {
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
 * Runs exactly once per mount (`startedRef`), so a failed recovery cannot retrigger itself.
 */
export function useSigninRecovery(nextPath: string | undefined): { recovering: boolean } {
  const router = useRouter();
  const [recovering, setRecovering] = useState(true);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;

    const run = async () => {
      const observed: SigninRecoveryInput = {
        isNativeShell: isNativeShell(),
        // Read fresh from the store rather than subscribing: this effect runs once and must
        // see the flag's value at mount, not restart when it later changes.
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

    void run();

    return () => {
      cancelled = true;
    };
    // Intentionally mount-only: nextPath is captured at mount, and recovery must not restart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { recovering };
}

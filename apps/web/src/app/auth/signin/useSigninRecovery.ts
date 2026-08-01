'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchWithAuth, refreshAuthSession } from '@/lib/auth/auth-fetch';
import { getPlatformStorage } from '@/lib/auth/platform-storage';
import { useAuthStore } from '@/stores/useAuthStore';
import { decideSigninRecovery, type SigninRecoveryInput } from './signin-recovery';

const DEFAULT_NEXT = '/dashboard';

// Matches AuthFetch's TOKEN_RETRIEVAL_TIMEOUT_MS (auth-fetch.ts) — same underlying Keychain
// round-trip, same "can hang during app launch on iOS" hazard. Exported so the regression test
// can assert against it directly instead of a hardcoded duplicate that could silently drift.
export const DEVICE_TOKEN_TIMEOUT_MS = 3000;

// Bounds checkMeAuthenticated's fetchWithAuth call — long enough to cover a legitimate
// refresh-and-retry cycle happening inside that same call, short enough to bound the loading
// screen against a true network stall (no rejection, no resolution).
export const CHECK_ME_TIMEOUT_MS = 8000;

// Backstop for the whole recovery driver — longer than the worst-case chain (up to
// DEVICE_TOKEN_TIMEOUT_MS Keychain read + up to CHECK_ME_TIMEOUT_MS check-me + margin), so it
// never fires on a normal run. Guards against a hang anywhere in the chain we haven't found
// (or guarded) yet, including outside the two fetches above.
export const RECOVERY_FAILSAFE_TIMEOUT_MS = 12000;

/**
 * Whether a device token exists to recover an expired session from — read from PLATFORM storage
 * (D1): desktop reads safeStorage over IPC (window.electron.auth) via DesktopStorage, web reads
 * localStorage via WebStorage. The old localStorage-only check saw nothing on desktop, which is
 * why native shells could never self-recover. Async because the desktop read is an IPC round-trip.
 *
 * Raced against a timeout because the underlying native call can hang indefinitely (iOS
 * Keychain access during app launch) — same hazard `getSessionTokenWithTimeout` guards
 * against in auth-fetch.ts. Without this, a hung call leaves `recovering` stuck `true`
 * forever, stranding the user on the loading screen.
 */
async function hasDeviceToken(): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), DEVICE_TOKEN_TIMEOUT_MS);
  });

  try {
    const session = await Promise.race([
      getPlatformStorage().getStoredSession(),
      timeoutPromise,
    ]);
    return !!session?.deviceToken;
  } catch {
    // Storage unavailable (IPC failure / SSR) — treat as no token and fall through to the form.
    return false;
  } finally {
    clearTimeout(timeoutId!);
  }
}

/**
 * Observe the current session via GET /api/auth/me through `fetchWithAuth` (D1): it attaches the
 * Bearer token on native shells and, crucially, its own refresh-on-401 IS the recovery — a 401
 * here transparently mints a fresh session from the device token before we ever decide to show
 * the form. A raw `fetch` would have skipped both.
 */
async function checkMeAuthenticated(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHECK_ME_TIMEOUT_MS);

  try {
    const response = await fetchWithAuth('/api/auth/me', {
      credentials: 'include',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    // Network error (including an abort on timeout) — treat as unauthenticated and fall
    // through to the device-token path.
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Imperative shell for silent session recovery on the signin page.
 *
 * Runs the effects — GET /api/auth/me (via fetchWithAuth), reading the device token from
 * platform storage, the AuthFetch refresh, the router navigation — and defers every decision to
 * the pure `decideSigninRecovery` core. See ./signin-recovery.ts for why this exists (the
 * 2026-07-07 middleware change that started bouncing recoverable sessions to the signin form,
 * and the D1 fix that lets native shells recover too).
 *
 * Returns `recovering`: while true, the page shows a minimal loading state instead of the
 * form, so a user who is about to be redirected never sees the form flash. It flips to
 * false only when recovery lands on the form; on a redirect it stays true through the
 * navigation.
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

    // Unconditional backstop: whatever hangs anywhere in the chain below, the loading screen
    // cannot outlive this timer. Cleared on every terminal path (show-form, redirect, the
    // fail-open catch, and unmount) so it never fires after a normal completion.
    const failsafeTimer = setTimeout(() => {
      if (!cancelled) setRecovering(false);
    }, RECOVERY_FAILSAFE_TIMEOUT_MS);

    const run = async () => {
      const observed: SigninRecoveryInput = {
        // Read fresh from the store rather than subscribing: this effect runs once and must
        // see the flag's value when recovery starts, not restart when it later changes.
        authFailedPermanently: useAuthStore.getState().authFailedPermanently,
        meAuthenticated: undefined,
        hasDeviceToken: await hasDeviceToken(),
        refreshSucceeded: undefined,
      };
      if (cancelled) return;

      // Drive the pure machine: perform each action, feed the result back, repeat until
      // a terminal action. The machine never loops back to an earlier step, and every
      // effect below is a strictly-forward observation, so this cannot spin.
      for (;;) {
        if (cancelled) return;
        const action = decideSigninRecovery(observed);

        switch (action.type) {
          case 'show-form':
            clearTimeout(failsafeTimer);
            if (!cancelled) setRecovering(false);
            return;

          case 'redirect':
            // Keep `recovering` true through the navigation so the form never flashes.
            clearTimeout(failsafeTimer);
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
    // is the app's primary auth entry point). `refreshAuthSession`/`fetchWithAuth` resolve a
    // result today, but their types make no never-throw guarantee, and neither does a dynamic
    // import inside them.
    void run().catch(() => {
      clearTimeout(failsafeTimer);
      if (!cancelled) setRecovering(false);
    });

    return () => {
      cancelled = true;
      clearTimeout(failsafeTimer);
    };
    // Starts once, when `ready` flips true; `nextPath` is fully resolved by then and stable
    // thereafter (browserPath is set a single time), so it is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return { recovering };
}

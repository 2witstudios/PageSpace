import { describe, it, expect } from 'vitest';
import { shouldShowAuthLoadingScreen } from '../shouldShowAuthLoadingScreen';

describe('shouldShowAuthLoadingScreen', () => {
  it('given hydration has not completed yet, should show the loading screen regardless of anything else', () => {
    expect(
      shouldShowAuthLoadingScreen({
        hasHydrated: false,
        isLoading: false,
        isAuthenticated: true,
        hasConfirmedAuthThisMount: true,
      }),
    ).toBe(true);
  });

  it('given a cold boot (hydrated, loading, never authenticated), should show the loading screen', () => {
    expect(
      shouldShowAuthLoadingScreen({
        hasHydrated: true,
        isLoading: true,
        isAuthenticated: false,
        hasConfirmedAuthThisMount: false,
      }),
    ).toBe(true);
  });

  // Regression: this is the case that used to unmount the ENTIRE app shell — including
  // GlobalChatProvider, tearing down every socket room and wiping usePendingStreamsStore —
  // for a routine 15-minute background loadSession() recheck of an already-good session.
  // hasConfirmedAuthThisMount: true because this mount already rendered authenticated once —
  // that's what makes it a background recheck rather than a fresh boot.
  it('given a background re-check of an ALREADY-authenticated session (isLoading transiently true), should NOT show the loading screen', () => {
    expect(
      shouldShowAuthLoadingScreen({
        hasHydrated: true,
        isLoading: true,
        isAuthenticated: true,
        hasConfirmedAuthThisMount: true,
      }),
    ).toBe(false);
  });

  it('given hydrated, not loading, and authenticated (the steady state), should not show the loading screen', () => {
    expect(
      shouldShowAuthLoadingScreen({
        hasHydrated: true,
        isLoading: false,
        isAuthenticated: true,
        hasConfirmedAuthThisMount: true,
      }),
    ).toBe(false);
  });

  // Regression (review finding, PR #2312): a hard reload can restore a STALE persisted
  // isAuthenticated: true (useAuthStore's partialize) for a session that was actually
  // expired/revoked while the tab was closed. hasConfirmedAuthThisMount is false here
  // because this mount has never itself observed a successful check — the persisted flag
  // is unverified. Bypassing the loading screen in this exact case would render real
  // cached drive/sidebar data before the first check's eventual 401 redirects away.
  // Only a background recheck WITHIN an already-confirmed mount should bypass it.
  it("given a fresh mount's FIRST auth check is in flight, with stale persisted isAuthenticated: true, should still show the loading screen", () => {
    expect(
      shouldShowAuthLoadingScreen({
        hasHydrated: true,
        isLoading: true,
        isAuthenticated: true,
        hasConfirmedAuthThisMount: false,
      }),
    ).toBe(true);
  });
});

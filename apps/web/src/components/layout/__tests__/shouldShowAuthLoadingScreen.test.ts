import { describe, it, expect } from 'vitest';
import { shouldShowAuthLoadingScreen } from '../shouldShowAuthLoadingScreen';

describe('shouldShowAuthLoadingScreen', () => {
  it('given hydration has not completed yet, should show the loading screen regardless of anything else', () => {
    expect(
      shouldShowAuthLoadingScreen({ hasHydrated: false, isLoading: false, isAuthenticated: true }),
    ).toBe(true);
  });

  it('given a cold boot (hydrated, loading, never authenticated), should show the loading screen', () => {
    expect(
      shouldShowAuthLoadingScreen({ hasHydrated: true, isLoading: true, isAuthenticated: false }),
    ).toBe(true);
  });

  // Regression: this is the case that used to unmount the ENTIRE app shell — including
  // GlobalChatProvider, tearing down every socket room and wiping usePendingStreamsStore —
  // for a routine 15-minute background loadSession() recheck of an already-good session.
  it('given a background re-check of an ALREADY-authenticated session (isLoading transiently true), should NOT show the loading screen', () => {
    expect(
      shouldShowAuthLoadingScreen({ hasHydrated: true, isLoading: true, isAuthenticated: true }),
    ).toBe(false);
  });

  it('given hydrated, not loading, and authenticated (the steady state), should not show the loading screen', () => {
    expect(
      shouldShowAuthLoadingScreen({ hasHydrated: true, isLoading: false, isAuthenticated: true }),
    ).toBe(false);
  });
});

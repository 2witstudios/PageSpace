/**
 * Should `Layout` blank its entire subtree (TopBar, sidebars, CenterPanel, RightPanel,
 * and — critically — `GlobalChatProvider`, which owns every socket room subscription
 * and the pending-streams store) down to a bare spinner?
 *
 * Only for a genuine cold boot — never for `loadSession`'s routine background
 * revalidation of an already-authenticated session (`isAuthenticated: true` persists
 * across reloads via `useAuthStore`'s `partialize`, but `isLoading` flips true on
 * every `loadSession` call, cold boot or 15-minute background recheck alike). Gating
 * the whole shell on that background case is what turned an ordinary auth refresh
 * into a whole-screen unmount/remount — tearing down every live socket room and
 * wiping `usePendingStreamsStore` in the process.
 *
 * `hasConfirmedAuthThisMount` (review finding, PR #2312) closes a gap the above
 * alone leaves open: `isAuthenticated: true` is itself persisted, so a hard reload
 * with a session that actually expired/was revoked while the tab was closed would
 * otherwise bypass the screen on its very FIRST, still-unverified check — rendering
 * real cached drive/sidebar data before the eventual 401 redirects away. The caller
 * (`Layout.tsx`) tracks this per-mount, not per-store, deliberately: it's "has THIS
 * tab observed a successful check yet," which starts false on every fresh mount
 * regardless of what `isAuthenticated` was restored to, and only a LATER background
 * recheck within an already-confirmed mount may skip the screen.
 */
export function shouldShowAuthLoadingScreen(state: {
  isLoading: boolean;
  hasHydrated: boolean;
  isAuthenticated: boolean;
  hasConfirmedAuthThisMount: boolean;
}): boolean {
  return (
    !state.hasHydrated ||
    (state.isLoading && (!state.isAuthenticated || !state.hasConfirmedAuthThisMount))
  );
}

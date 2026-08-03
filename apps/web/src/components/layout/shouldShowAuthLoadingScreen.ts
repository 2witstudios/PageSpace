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
 */
export function shouldShowAuthLoadingScreen(state: {
  isLoading: boolean;
  hasHydrated: boolean;
  isAuthenticated: boolean;
}): boolean {
  return !state.hasHydrated || (state.isLoading && !state.isAuthenticated);
}

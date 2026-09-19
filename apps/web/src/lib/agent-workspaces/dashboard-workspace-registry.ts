/**
 * WHICH workspace backs the dashboard — for WHICH user.
 *
 * A single module-level slot, deliberately: it is not UI state but the fact
 * "THIS user's dashboard layout lives in workspace X", learned once when
 * `DashboardWorkspaceView` provisions the workspace and read afterwards by
 * surfaces with no dashboard view mounted (the sidebar's and voice's "new
 * conversation" path). One creation path is the point — `GlobalChatContext`'s
 * `createNewConversation` mints into the registered workspace when it matches
 * the signed-in user, so the grid and the app identity cannot drift.
 *
 * The slot is keyed by userId and READERS MUST PRESENT THE SAME ID: an entry
 * left behind by a logout (the tab is rarely torn down between accounts)
 * self-invalidates rather than minting a new user's conversation into the
 * previous user's workspace. There is deliberately no reset-on-logout hook —
 * the key IS the invalidation.
 *
 * Deliberately never unregistered on success either: a provisioned dashboard
 * workspace is a permanent row (`agent_workspaces.kind = 'dashboard'`), its
 * id is stable for the session, and "New" should keep minting into it even
 * while the user is on a page route with no grid mounted.
 */

interface DashboardWorkspaceRegistration {
  userId: string;
  workspaceId: string;
}

let registration: DashboardWorkspaceRegistration | null = null;

export function registerDashboardWorkspace(userId: string, workspaceId: string): void {
  registration = { userId, workspaceId };
}

export function getRegisteredDashboardWorkspaceId(userId: string): string | null {
  return registration !== null && registration.userId === userId
    ? registration.workspaceId
    : null;
}

/** Test seam — resets the slot between tests. */
export function resetDashboardWorkspaceRegistry(): void {
  registration = null;
}

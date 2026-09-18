/**
 * WHICH workspace backs the dashboard, this session.
 *
 * A single module-level slot — not a store, not a context — because it is not
 * UI state: it is the fact "the user's dashboard layout lives in workspace X",
 * learned once when `DashboardWorkspaceView` provisions the workspace and read
 * afterwards by surfaces that have no dashboard view mounted at all. The
 * reader today is `GlobalChatContext`'s `createNewConversation`: a new
 * assistant thread minted from anywhere (sidebar, voice) is born INTO the
 * dashboard workspace when one exists, so the app has ONE creation path and
 * the dashboard grid, the sidebar, and the cookie identity can never drift
 * into three different conversations.
 *
 * Deliberately never unregistered: a provisioned dashboard workspace is a
 * permanent row (`agent_workspaces.kind = 'dashboard'`), its id is stable for
 * the life of the tab session, and the sidebar's "New" should keep minting
 * into it even while the user is on a page route with no grid mounted.
 */

let dashboardWorkspaceId: string | null = null;

export function registerDashboardWorkspace(workspaceId: string): void {
  dashboardWorkspaceId = workspaceId;
}

export function getRegisteredDashboardWorkspaceId(): string | null {
  return dashboardWorkspaceId;
}

/** Test seam — resets the slot between tests. */
export function resetDashboardWorkspaceRegistry(): void {
  dashboardWorkspaceId = null;
}

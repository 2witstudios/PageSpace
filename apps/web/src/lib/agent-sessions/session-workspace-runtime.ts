/**
 * Production wiring for a session's persisted pane grid — the
 * `agent_sessions.workspaceState` jsonb column, read/written as one unit.
 *
 * Deliberately a plain, direct read/write rather than routed through
 * `AgentSessionStore` (`agent-sessions-runtime.ts`): the column is a single
 * self-contained blob with no lifecycle of its own (no create/list/quota
 * concerns a store abstraction earns its keep on), same discipline
 * `session-shells-runtime.ts`'s own bulk-listing helper already uses for a
 * narrow, store-bypassing query. Access control is NOT this module's job —
 * every route calling into it runs `checkSessionAccess`
 * (`agent-sessions-runtime.ts`) first, same as every other session-scoped route.
 */

import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { agentSessions } from '@pagespace/db/schema/agent-sessions';
import type { PersistedWorkspaceState } from '@pagespace/lib/agent-sessions/contract';

/** `null` when the session has no row (never happens for a real session id) or has never saved a grid yet. */
export async function getSessionWorkspace(sessionId: string): Promise<PersistedWorkspaceState | null> {
  const [row] = await db
    .select({ workspaceState: agentSessions.workspaceState })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return (row?.workspaceState as PersistedWorkspaceState | undefined) ?? null;
}

/**
 * The saved grid of MANY sessions in one query — same "children in bulk
 * queries" shape `listShellsBulk`/`listSessionConversationsBulk` already use
 * for the collection GET (review M4: one query per session per sidebar poll).
 * A session with no saved grid yet simply has no entry — callers default to
 * `null` per session, same as the single-session `getSessionWorkspace`.
 */
export async function getSessionWorkspacesBulk(
  sessionIds: string[],
): Promise<Map<string, PersistedWorkspaceState>> {
  const grouped = new Map<string, PersistedWorkspaceState>();
  if (sessionIds.length === 0) return grouped;
  const rows = await db
    .select({ id: agentSessions.id, workspaceState: agentSessions.workspaceState })
    .from(agentSessions)
    .where(inArray(agentSessions.id, sessionIds));
  for (const row of rows) {
    if (row.workspaceState) grouped.set(row.id, row.workspaceState as PersistedWorkspaceState);
  }
  return grouped;
}

/** Overwrite the session's saved grid wholesale — the caller has already validated `workspace` against `persistedWorkspaceStateSchema`. */
export async function saveSessionWorkspace(input: {
  sessionId: string;
  workspace: PersistedWorkspaceState;
}): Promise<void> {
  await db
    .update(agentSessions)
    .set({ workspaceState: input.workspace })
    .where(eq(agentSessions.id, input.sessionId));
}

/**
 * MAY THIS CALLER BIND THIS TARGET INTO THIS GRID? (security review HIGH 1,
 * attack B.)
 *
 * A layout verb's `scope` is caller-supplied: `workspaceLayoutVerbSchema`
 * validates that `ensure` / `assign_pane` / `open_conversation` /
 * `replace_conversation` carry a `{kind, targetId}`, and nothing more. The
 * verbs route checked only that the caller could reach the WORKSPACE, so any
 * authenticated user could create a workspace of their own, bind an arbitrary
 * conversation / shell / page id into it, and read the joined title back out
 * of the response grid — a title oracle (and an existence oracle) over
 * resources they have no access to whatsoever.
 *
 * This is the WRITE half of the fix. The read half (`resolvePaneLabels` in
 * ./workspace-layout-runtime.ts) refuses to resolve a label the viewer has no
 * authority for, and is what actually stops the disclosure; this gate stops
 * the bad row from being written at all, which matters because a pane row
 * outlives the request that created it and is re-read by every later viewer
 * of that grid.
 *
 * The two halves share ONE rule per kind, deliberately:
 *   - `page`     — the viewer must be able to view the page.
 *   - `terminal` — the shell must belong to THIS workspace (shells are
 *                  workspace-scoped rows, so containment is the whole rule).
 *   - `chat`     — the conversation must already live in this workspace, or
 *                  be one the viewer may access on its own footing
 *                  (`canAccessConversation`: their own, or shared + page
 *                  access).
 *
 * Refusal is UNIFORM across "forbidden" and "does not exist": every negative
 * answer is a plain `false`, so a caller probing ids learns nothing from the
 * difference — the same family policy the session-access routes apply.
 *
 * Functional core / imperative shell: the decision takes injected lookups so
 * it is testable without a database, and the default deps are the only place
 * that touches one.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { agentWorkspaceShells } from '@pagespace/db/schema/agent-workspaces';
import { canAccessConversation } from '@pagespace/lib/permissions/conversation-access';
import { getUserAccessLevel } from '@pagespace/lib/permissions/permissions';
import type { PaneScope } from '@pagespace/lib/agent-workspaces/contract';
import type { WorkspaceLayoutVerb } from '@pagespace/lib/agent-workspaces/workspace-layout-verbs';

/** The conversation facts the chat rule needs — a subset of a `conversations` row. */
export interface PaneScopeConversationRow {
  userId: string;
  isShared: boolean;
  type: string;
  contextId: string | null;
  /** The workspace this conversation is bound to, or `null` for a plain thread. */
  workspaceId: string | null;
}

export interface PaneScopeAuthorityDeps {
  findConversation: (conversationId: string) => Promise<PaneScopeConversationRow | null>;
  /** The workspace a shell belongs to, or `null` when there is no such shell. */
  findShellWorkspace: (shellId: string) => Promise<string | null>;
  canViewPage: (userId: string, pageId: string) => Promise<boolean>;
}

/**
 * PURE: every pane scope a verb would bind. Exhaustive over the verb union by
 * construction — a new scope-carrying verb that is not listed here is a
 * compile error rather than a silently ungated write path.
 */
export function paneScopesOfVerb(verb: WorkspaceLayoutVerb): PaneScope[] {
  switch (verb.type) {
    case 'ensure':
    case 'assign_pane':
    case 'open_conversation':
    case 'replace_conversation':
      return [verb.scope];
    default:
      return [];
  }
}

const defaultDeps: PaneScopeAuthorityDeps = {
  findConversation: async (conversationId) => {
    const [row] = await db
      .select({
        userId: conversations.userId,
        isShared: conversations.isShared,
        type: conversations.type,
        contextId: conversations.contextId,
        workspaceId: conversations.workspaceId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    return row ? { ...row, isShared: row.isShared === true } : null;
  },
  findShellWorkspace: async (shellId) => {
    const [row] = await db
      .select({ workspaceId: agentWorkspaceShells.workspaceId })
      .from(agentWorkspaceShells)
      .where(eq(agentWorkspaceShells.id, shellId))
      .limit(1);
    return row?.workspaceId ?? null;
  },
  canViewPage: async (userId, pageId) => (await getUserAccessLevel(userId, pageId)) !== null,
};

/**
 * May `viewerId` bind `scope` into `workspaceId`'s grid? See the module doc
 * for the per-kind rule. An unbound scope (`targetId: null` — the picker just
 * chose a kind) needs no authority: there is nothing to resolve yet.
 */
export async function authorizePaneScope(
  input: { viewerId: string; workspaceId: string; scope: PaneScope },
  deps: PaneScopeAuthorityDeps = defaultDeps,
): Promise<boolean> {
  const { viewerId, workspaceId, scope } = input;
  if (scope.targetId === null) return true;

  switch (scope.kind) {
    case 'page':
      return deps.canViewPage(viewerId, scope.targetId);

    case 'terminal':
      return (await deps.findShellWorkspace(scope.targetId)) === workspaceId;

    case 'chat': {
      const row = await deps.findConversation(scope.targetId);
      if (!row) return false;
      // Already in this grid: the caller passed the session-access gate to get
      // here, so the conversation is one this workspace already lists to them
      // (with its title redacted, if the listing rule says so).
      if (row.workspaceId === workspaceId) return true;
      return canAccessConversation(viewerId, row, {
        getPageAccess: (userId, pageId) => deps.canViewPage(userId, pageId),
      });
    }
  }
}

/**
 * Authorize every scope a verb carries. `true` when the verb binds nothing —
 * a resize or a close has no target to check.
 */
export async function authorizeVerbScopes(
  input: { viewerId: string; workspaceId: string; verb: WorkspaceLayoutVerb },
  deps: PaneScopeAuthorityDeps = defaultDeps,
): Promise<boolean> {
  const scopes = paneScopesOfVerb(input.verb);
  for (const scope of scopes) {
    const allowed = await authorizePaneScope(
      { viewerId: input.viewerId, workspaceId: input.workspaceId, scope },
      deps,
    );
    if (!allowed) return false;
  }
  return true;
}

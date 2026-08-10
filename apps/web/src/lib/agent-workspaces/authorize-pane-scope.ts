/**
 * MAY THIS CALLER BIND THIS TARGET INTO THIS WORKSPACE? (security review
 * HIGH 1, attack B.)
 *
 * A pane's target is caller-supplied: the write payload states a
 * `{kind, targetId}` and nothing more. A route that checked only that the
 * caller could reach the WORKSPACE would let any authenticated user create a
 * workspace of their own, bind an arbitrary conversation / shell / page id into
 * it, and read the joined title back out of the response — a title oracle (and
 * an existence oracle) over resources they have no access to whatsoever.
 *
 * This is the WRITE half of the fix. The read half (`resolveTargets` in
 * ./workspace-node-runtime.ts) refuses to resolve a label the viewer has no
 * authority for, and is what actually stops the disclosure; this gate stops
 * the bad row from being written at all, which matters because a node row
 * outlives the request that created it and is re-read by every later viewer
 * of that workspace.
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
import { findWorkspaceOfChat } from '@pagespace/lib/services/agent-workspaces/workspace-membership-store';
import { getUserAccessLevel } from '@pagespace/lib/permissions/permissions';
import type { PaneTargetKind, WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';

/** The conversation facts the chat rule needs — a subset of a `conversations` row. */
export interface PaneScopeConversationRow {
  userId: string;
  isShared: boolean;
  type: string;
  contextId: string | null;
  /**
   * The workspace whose TREE holds this conversation, or `null` for a thread
   * that belongs to none.
   *
   * Read from `agent_workspace_nodes` rather than from
   * `conversations.workspaceId`, because membership is the node row now. The
   * containment rule below is unchanged in what it asks; only where the answer
   * comes from has moved.
   */
  workspaceId: string | null;
}

export interface PaneScopeAuthorityDeps {
  findConversation: (conversationId: string) => Promise<PaneScopeConversationRow | null>;
  /** The workspace a shell belongs to, or `null` when there is no such shell. */
  findShellWorkspace: (shellId: string) => Promise<string | null>;
  canViewPage: (userId: string, pageId: string) => Promise<boolean>;
}

/** The slice of a Drizzle client the row lookups need — `db` and a transaction alike. */
type PaneScopeExecutor = Pick<typeof db, 'select'>;

/**
 * The production lookups, bound to an EXECUTOR.
 *
 * A caller inside the membership write's transaction passes `tx`, and it has
 * to: the conversation (or the shell) being introduced may be one that
 * transaction just inserted, and a containment check on the pooled connection
 * cannot see an uncommitted row — so it would refuse exactly the write that
 * created the thing it is asking about.
 *
 * `canViewPage` is deliberately NOT executor-bound. Page ACLs are never written
 * by a layout transaction, so `getUserAccessLevel`'s own reads have nothing to
 * miss, and threading an executor through the permission layer for a fact it
 * cannot be racing would be reach for its own sake.
 */
export function paneScopeDeps(executor: PaneScopeExecutor = db): PaneScopeAuthorityDeps {
  return {
    findConversation: async (conversationId) => {
      const [row] = await executor
        .select({
          userId: conversations.userId,
          isShared: conversations.isShared,
          type: conversations.type,
          contextId: conversations.contextId,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (!row) return null;
      // MEMBERSHIP, from the tree. One lookup on the global chat-target index,
      // which is unique — so "which workspace holds this thread" has exactly one
      // answer rather than a column two writers could disagree about.
      const workspaceId = await findWorkspaceOfChat(executor, conversationId);
      return { ...row, isShared: row.isShared === true, workspaceId };
    },
    findShellWorkspace: async (shellId) => {
      const [row] = await executor
        .select({ workspaceId: agentWorkspaceShells.workspaceId })
        .from(agentWorkspaceShells)
        .where(eq(agentWorkspaceShells.id, shellId))
        .limit(1);
      return row?.workspaceId ?? null;
    },
    canViewPage: async (userId, pageId) => (await getUserAccessLevel(userId, pageId)) !== null,
  };
}

const defaultDeps: PaneScopeAuthorityDeps = paneScopeDeps();

/**
 * The half of a pane binding this gate actually reads.
 *
 * `{kind, targetId}` and deliberately not `PaneTarget` itself: a `targetId` of
 * `null` is an unbound pane, which the node model spells as `target: null` on
 * the node rather than as a target with a null id. Widening here rather than
 * narrowing at every call site keeps one rule per kind and one implementation
 * of it — the alternative was a second copy of the chat containment rule, which
 * is the drift this epic exists to remove.
 */
export interface AuthorizablePaneTarget {
  kind: PaneTargetKind;
  /** `null` is an unbound pane — nothing to resolve, so nothing to authorize. */
  targetId: string | null;
}

/**
 * May `viewerId` bind `scope` into `workspaceId`'s grid? See the module doc
 * for the per-kind rule. An unbound scope (`targetId: null` — the picker just
 * chose a kind) needs no authority: there is nothing to resolve yet.
 */
export async function authorizePaneScope(
  input: { viewerId: string; workspaceId: string; scope: AuthorizablePaneTarget },
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
 * THE NODE ROUTE'S GATE: authorize the bindings a write INTRODUCES, and only
 * those.
 *
 * The verb route could authorize whatever its verb carried, because a verb named
 * exactly the one target it was binding. A node payload does not: `put` is a set
 * of whole nodes, so a plain resize re-sends every affected pane WITH its
 * existing target, and gating on "every target in the payload" would mean a
 * viewer who lost access to one page could no longer move, resize, or even CLOSE
 * any pane in their own workspace — closing is a `put` with `parentId: null`, so
 * the trap has no exit. The rule that keeps the gate honest without building
 * that trap is CONTAINMENT: a `(kind, id)` already held by a node in this
 * workspace is not something the caller is introducing, and it passed this gate
 * when it arrived.
 *
 * `current` must therefore be the tree read UNDER THE LOCK, not a lock-free
 * pre-read. Between an unlocked read and the write, another client can remove
 * the node that was holding a target — which would turn a re-send into an
 * introduction that this gate had already waved through on the strength of a
 * tree that no longer exists. The cost is that a few permission queries run
 * inside the per-workspace advisory lock; the alternative is a race whose payoff
 * is exactly the disclosure the gate exists to stop.
 */
export function introducedPaneTargets(
  current: readonly WorkspaceNode[],
  put: readonly WorkspaceNode[],
): AuthorizablePaneTarget[] {
  const held = new Set<string>();
  for (const node of current) {
    if (node.nodeType === 'pane' && node.target !== null) held.add(`${node.target.kind}:${node.target.id}`);
  }
  const introduced = new Map<string, AuthorizablePaneTarget>();
  for (const node of put) {
    if (node.nodeType !== 'pane' || node.target === null) continue;
    const key = `${node.target.kind}:${node.target.id}`;
    if (held.has(key)) continue;
    introduced.set(key, { kind: node.target.kind, targetId: node.target.id });
  }
  return [...introduced.values()];
}

/** Authorize a set of targets, refusing the whole write on the first denial. */
export async function authorizePaneTargets(
  input: { viewerId: string; workspaceId: string; targets: readonly AuthorizablePaneTarget[] },
  deps: PaneScopeAuthorityDeps = defaultDeps,
): Promise<boolean> {
  for (const scope of input.targets) {
    const allowed = await authorizePaneScope(
      { viewerId: input.viewerId, workspaceId: input.workspaceId, scope },
      deps,
    );
    if (!allowed) return false;
  }
  return true;
}

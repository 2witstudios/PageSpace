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
import type { PaneKind, PaneScope } from '@pagespace/lib/agent-workspaces/contract';
import type { WorkspaceLayoutVerb } from '@pagespace/lib/agent-workspaces/workspace-layout-verbs';
import type { WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';

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
 *
 * Every one of the twelve verbs is named, and the fall-through assigns to
 * `never`. A `default: return []` would have made the claim above false in the
 * most dangerous direction: a verb added to `workspaceLayoutVerbSchema` with a
 * `scope` would yield NO scopes here, so `authorizeVerbScopes` would wave it
 * through and the unauthorized pane row would be written. The read half
 * (`resolvePaneLabels`) would still redact the label, but the row outlives the
 * request. So the cost of forgetting must be a build failure, not a silent
 * hole — which means listing the scope-free verbs by name rather than letting
 * a default absorb them.
 */
export function paneScopesOfVerb(verb: WorkspaceLayoutVerb): PaneScope[] {
  switch (verb.type) {
    // Scope-carrying: these are the write paths the gate exists for.
    case 'ensure':
    case 'assign_pane':
    case 'open_conversation':
    case 'replace_conversation':
      return [verb.scope];

    // Structural only — they move, size or clear panes that are already bound,
    // and carry no target to authorize.
    case 'split_right':
    case 'split_down':
    case 'close_pane':
    case 'reset_pane':
    case 'resize_column':
    case 'resize_pane':
    case 'move_pane':
    case 'reorder_columns':
      return [];

    default: {
      const _exhaustive: never = verb;
      void _exhaustive;
      return [];
    }
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
 * The half of a `PaneScope` this gate actually reads.
 *
 * Narrowed to `{kind, targetId}` so the NODE model's `PaneTarget` — which
 * carries no display label, because a node's title is resolved beside the tree
 * rather than stored inside it — reaches the same gate as the verb model's
 * scope. One rule per kind, one implementation, two callers: the alternative was
 * a second copy of the chat containment rule for the node route, which is the
 * drift this epic exists to remove.
 */
export interface AuthorizablePaneTarget {
  kind: PaneKind;
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

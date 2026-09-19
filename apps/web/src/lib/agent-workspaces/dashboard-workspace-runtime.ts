/**
 * The DASHBOARD WORKSPACE — the per-user pane tree that backs the dashboard
 * surface itself (`agent_workspaces.kind = 'dashboard'`).
 *
 * Why it exists: every other chat surface (agent pages, the Agents console,
 * right-sidebar panes) renders out of a workspace node tree, which is what
 * makes it splittable — the tree is the layout. The dashboard was the one
 * surface with no tree, so it could not host panes at all. This module
 * provisions that tree lazily, the same way the Home drive is provisioned:
 * first visit creates it, every visit after reads it.
 *
 * The tree is born with exactly one pane — a chat pane bound to the caller's
 * ACTIVE global-assistant conversation when that bind is legal, unbound
 * (picker) otherwise — so the grid's day-one rendering matches the dashboard
 * that preceded it: one assistant conversation, full height. From there it is
 * an ordinary workspace: `splitPane`, `open_page_pane`, shells — the whole
 * pane vocabulary works on it unchanged, because it IS an ordinary workspace.
 *
 * Binding legality (checked server-side, never trusted from the client):
 *  - the conversation id must be the caller's own (an unknown id is treated
 *    as client-minted-lazy and CREATED here — that is how the global
 *    conversation identity works, see `conversation-state.ts` — but a row
 *    owned by someone else is refused silently by leaving the pane unbound);
 *  - the conversation must be bound to NO node anywhere
 *    (`agent_workspace_nodes_chat_target_idx` is global), because membership
 *    moves by fork, never rebind — a thread already on screen elsewhere stays
 *    there and the dashboard pane opens as a picker instead.
 *
 * One dashboard per owner WHILE OPEN: the partial unique index
 * `agent_workspaces_one_open_dashboard_idx` is the race arbiter (the same
 * pattern as the Home drive's), and this function treats a losing insert as
 * "someone else won the race" — it re-reads and returns the winner.
 */

import { db } from '@pagespace/db/db';
import { and, eq, isNull } from '@pagespace/db/operators';
import { createId } from '@paralleldrive/cuid2';
import { conversations } from '@pagespace/db/schema/conversations';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import {
  agentWorkspaceNodeRevs,
  agentWorkspaceNodes,
} from '@pagespace/db/schema/agent-workspace-nodes';
import type { WorkspaceNodeSnapshotResponse } from '@pagespace/lib/agent-workspaces/workspace-node-wire';
import { readWorkspaceNodes } from './workspace-node-runtime';

export interface DashboardWorkspace {
  workspaceId: string;
  /** Whether this call CREATED the workspace (vs reading the existing one). */
  created: boolean;
  /**
   * The conversation ACTUALLY bound to the seed pane on creation — null when
   * the request's id was refused (foreign, already bound, or absent). This is
   * the audit truth, deliberately distinct from what the caller ASKED to bind.
   */
  seededConversationId: string | null;
  snapshot: WorkspaceNodeSnapshotResponse;
}

/**
 * Get-or-create the caller's open dashboard workspace and return its node
 * snapshot — the exact shape `GET /api/agent-workspaces/[id]/nodes` answers,
 * so a client seats a fresh tree and a returned one identically.
 *
 * `conversationId` is the caller's active global-assistant conversation (the
 * dashboard's cookie identity). Optional: without it the tree still seeds,
 * with an unbound chat pane.
 */
export async function getOrCreateDashboardWorkspace(
  userId: string,
  conversationId: string | null,
): Promise<{ ok: true; workspace: DashboardWorkspace }> {
  const existing = await findOpenDashboardWorkspace(userId);
  if (existing) {
    return {
      ok: true,
      workspace: {
        workspaceId: existing.id,
        created: false,
        seededConversationId: null,
        snapshot: await readWorkspaceNodes(existing.id, userId),
      },
    };
  }

  const workspaceId = createId();
  let seededConversationId: string | null = null;

  try {
    await db.transaction(async (tx) => {
      await tx.insert(agentWorkspaces).values({
        id: workspaceId,
        ownerId: userId,
        driveId: null,
        envId: null,
        kind: 'dashboard',
        name: 'Dashboard',
      });
      await tx.insert(agentWorkspaceNodeRevs).values({ rootId: workspaceId, rev: 0 });
      // The bind resolves INSIDE the transaction: the conversation-row insert,
      // the ownership re-read, and the bind-clash check all see — and are
      // serialized against — the same committed state the seed write lands
      // on, closing the check-then-act windows the pre-transaction version
      // had (a rival claim between check and write now fails the whole
      // transaction atomically rather than half-landing).
      const bind =
        conversationId !== null && conversationId.length > 0
          ? await resolveBindableConversation(tx, userId, conversationId)
          : null;
      seededConversationId = bind;
      await tx.insert(agentWorkspaceNodes).values(dashboardSeedNodeRows(workspaceId, bind));
    });
  } catch (error) {
    // THE one unique violation that means "someone else provisioned first":
    // a concurrent provision (a second tab, a double render) won the
    // one-open-dashboard index. Lose the race, read the winner — never
    // surface the insert failure to the caller. Every OTHER unique violation
    // (the chat-binding index above, a PK collision) is a different fact and
    // propagates: the client's bounded SWR retries re-provision cleanly
    // against the state that refused us.
    if (isUniqueViolation(error, 'agent_workspaces_one_open_dashboard_idx')) {
      const winner = await findOpenDashboardWorkspace(userId);
      if (winner) {
        return {
          ok: true,
          workspace: {
            workspaceId: winner.id,
            created: false,
            seededConversationId: null,
            snapshot: await readWorkspaceNodes(winner.id, userId),
          },
        };
      }
    }
    throw error;
  }

  return {
    ok: true,
    workspace: {
      workspaceId,
      created: true,
      seededConversationId,
      snapshot: await readWorkspaceNodes(workspaceId, userId),
    },
  };
}

async function findOpenDashboardWorkspace(userId: string) {
  const [row] = await db
    .select({ id: agentWorkspaces.id })
    .from(agentWorkspaces)
    .where(
      and(
        eq(agentWorkspaces.ownerId, userId),
        eq(agentWorkspaces.kind, 'dashboard'),
        isNull(agentWorkspaces.endedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Whether `conversationId` may seed the first chat pane's binding.
 *
 * An unknown id is the client-minted lazy identity — CREATE the row here (same
 * shape `conversation-state.ts` mints on first message, just earlier), so the
 * dashboard's main thread is a real row from the moment its pane exists. A row
 * owned by someone else (an id collision, a stale cookie after an account
 * switch) refuses silently: the pane seeds unbound, and the picker offers a
 * legal conversation instead. Nothing about the refusal reaches the client,
 * because there is nothing for it to act on.
 */
async function resolveBindableConversation(
  tx: DashboardTx,
  userId: string,
  conversationId: string,
): Promise<string | null> {
  let [row] = await tx
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!row) {
    await tx
      .insert(conversations)
      .values({ id: conversationId, userId, type: 'global' })
      .onConflictDoNothing();
    // `onConflictDoNothing` is not ownership: the conflict could BE someone
    // else's row (an id space collision is vanishingly rare, but the check
    // is the invariant). Re-read, and only bind what the caller owns.
    [row] = await tx
      .select({ userId: conversations.userId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
  }
  if (!row || row.userId !== userId) {
    return null;
  }

  // Membership moves by fork, never rebind: a conversation already bound to a
  // node anywhere (another workspace, or a previous dashboard that still holds
  // it in its tree) cannot be seeded into this one. The unique index would
  // refuse the whole transaction; an explicit check refuses only the BIND.
  const [clash] = await tx
    .select({ id: agentWorkspaceNodes.id })
    .from(agentWorkspaceNodes)
    .where(
      and(
        eq(agentWorkspaceNodes.targetKind, 'chat'),
        eq(agentWorkspaceNodes.targetId, conversationId),
      ),
    )
    .limit(1);
  if (clash) {
    return null;
  }

  return conversationId;
}

/** The transaction handle drizzle hands the callback — typed, not `any`. */
type DashboardTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505' &&
    'constraint' in error &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}

/**
 * The day-one tree: a root and ONE chat pane under it, bound to the caller's
 * active global conversation when legal, a picker pane when not. Pure — the
 * same rows a fresh dashboard workspace always starts from, testable without
 * a database. The root's id IS the workspace id (workspace-node convention,
 * see `workspace-node-commands.ts`'s root builder).
 */
export function dashboardSeedNodeRows(
  workspaceId: string,
  boundConversationId: string | null,
): Array<typeof agentWorkspaceNodes.$inferInsert> {
  return [
    {
      id: workspaceId,
      rootId: workspaceId,
      parentId: null,
      position: 0,
      nodeType: 'root',
      axis: 'row',
      fraction: null,
      targetKind: null,
      targetId: null,
    },
    {
      id: createId(),
      rootId: workspaceId,
      parentId: workspaceId,
      position: 0,
      nodeType: 'pane',
      axis: null,
      fraction: null,
      // An UNBOUND pane carries neither half of the target — the row schema
      // (and the picker that renders it) treats "kind without id" as invalid.
      targetKind: boundConversationId !== null ? 'chat' : null,
      targetId: boundConversationId,
    },
  ];
}

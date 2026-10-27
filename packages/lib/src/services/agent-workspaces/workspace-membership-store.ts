/**
 * MEMBERSHIP READS — "which workspace holds this thread", and "which threads
 * does this workspace hold", asked of the node table.
 *
 * These are the questions `conversations.workspaceId` and `closedInWorkspaceAt`
 * used to answer, and they moved here for the reason the whole epic exists:
 * those columns and the pane rows were two structures for one fact, and nothing
 * kept them in correspondence. A node bound to a conversation IS the
 * membership, so the answer to all of them is one row.
 *
 * **Why this is not in `workspace-node-store.ts`.** That module is deliberately
 * ONE read and ONE write — the whole tree, atomically, and the write that
 * replaces it. These are neither: they are projections that deliberately do not
 * read a tree, because a caller asking "which workspace is this thread in" must
 * not have to load fifty nodes to find out, and a caller listing a workspace's
 * threads wants them joined to `conversations` rather than shaped as a tree.
 *
 * **The reads are index-shaped, and that is not incidental.**
 * `agent_workspace_nodes_chat_target_idx` is UNIQUE on `targetId` where
 * `targetKind = 'chat'` — global, across every workspace — so
 * {@link findWorkspaceOfChat} is a single-row lookup on a unique index and the
 * "exactly one workspace per thread" invariant is the database's rather than a
 * convention. {@link countChatMembers} is a prefix scan of the compound primary
 * key `(rootId, id)`.
 */

import { and, eq, isNotNull, sql } from '@pagespace/db/operators';
import { agentWorkspaceNodes } from '@pagespace/db/schema/agent-workspace-nodes';
import type { DbExecutor } from './workspace-lock';

/** The slice of a Drizzle client these reads need — satisfied by `db` and by a transaction alike. */
export type MembershipReadExecutor = Pick<DbExecutor, 'select'>;

/**
 * One thread's place in the workspace that holds it.
 *
 * It used to carry an `attached` boolean beside these two — on screen, or
 * parked — because a member could be in a workspace and nowhere in it. There is
 * one place a node can be, so membership and visibility are one fact and the
 * boolean has nothing left to report. A caller that wants "is this thread on
 * screen" is asking whether this row exists.
 */
export interface ChatMembershipRow {
  workspaceId: string;
  conversationId: string;
}

/**
 * WHERE THIS THREAD LIVES — or `null` for a thread that belongs to no workspace
 * (a plain page chat, the global assistant outside a session, or one whose node
 * a close destroyed).
 *
 * The successor to reading `conversations.workspaceId` AND
 * `closedInWorkspaceAt`, and it is one row rather than two columns precisely
 * because the two could disagree. It returns at most one row by construction:
 * the unique index makes a second binding a database error rather than a state
 * this function has to choose between.
 */
export async function findChatMembership(
  executor: MembershipReadExecutor,
  conversationId: string,
): Promise<ChatMembershipRow | null> {
  const [row] = await executor
    .select({ workspaceId: agentWorkspaceNodes.rootId })
    .from(agentWorkspaceNodes)
    .where(
      and(eq(agentWorkspaceNodes.targetKind, 'chat'), eq(agentWorkspaceNodes.targetId, conversationId)),
    )
    .limit(1);
  if (!row) return null;
  return { workspaceId: row.workspaceId, conversationId };
}

/** The workspace holding this conversation — THE lookup a chat turn folds its working context from. */
export async function findWorkspaceOfChat(
  executor: MembershipReadExecutor,
  conversationId: string,
): Promise<string | null> {
  return (await findChatMembership(executor, conversationId))?.workspaceId ?? null;
}

/**
 * How many conversations this workspace holds — the cap's INFORMATIONAL count.
 *
 * Deliberately not the cap's enforcement: `admit` counts the tree it is about
 * to write, inside the same locked transaction, so the ceiling cannot be
 * crossed by two callers who both read this a moment earlier. This exists for
 * the surfaces that want to warn a user BEFORE they act, which is a different
 * job with a different tolerance for being a moment out of date.
 */
export async function countChatMembers(
  executor: MembershipReadExecutor,
  workspaceId: string,
): Promise<number> {
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(agentWorkspaceNodes)
    .where(
      and(
        eq(agentWorkspaceNodes.rootId, workspaceId),
        eq(agentWorkspaceNodes.targetKind, 'chat'),
        isNotNull(agentWorkspaceNodes.targetId),
      ),
    );
  return row?.n ?? 0;
}


/**
 * SERVER-RESOLVED placement and rearrangement — how an agent puts something in
 * front of a user, and how it moves what is already there.
 *
 * Successor to `workspace-placement.ts`, and the differences are all consequences
 * of one change: a command is resolved by the SERVER against the tree it is
 * holding, inside the lock, instead of being computed by the caller against a
 * snapshot it read a moment earlier.
 *
 *  * **The rebase loop is gone.** `MAX_PLACEMENT_ATTEMPTS` existed because the
 *    old helper read a rev, computed a verb against it, POSTed, and could be
 *    told the rev had moved — an optimistic-concurrency dance a server has no
 *    reason to do with itself. `applyWorkspaceNodeCommand` decides against the
 *    only tree that can still be there when it commits.
 *  * **The `opId` is gone.** It existed so an SDK retry of one tool call
 *    replayed through the verb engine's op memory rather than placing a second
 *    pane. Placement is now idempotent by POLICY rather than by memory: `open`
 *    leaves a target that is already on screen exactly where it is and returns
 *    an empty write, so the second call writes nothing because there is nothing
 *    left to do — not because a table remembered the first.
 *
 * **The policy is PORTED, not reinvented.** `workspace-node-commands.ts`'s
 * `open` carries the rule for rule: a target already on screen is left alone,
 * the active pane wins when it qualifies, an agent ADDS rather than navigates
 * (`preferSplit`), the invoking conversation is never evicted
 * (`excludeTargetId`), a running shell is never given up, and nothing
 * replaceable means SPLIT rather than take something away. This module supplies
 * the two flags and nothing else.
 *
 * **Never throws.** A layout write is a courtesy on top of the model's actual
 * work; failing a turn because a pane could not be placed would be strictly
 * worse than the pane not appearing. Every entry point swallows and logs.
 */

import { db } from '@pagespace/db/db';
import { findWorkspaceOfChat } from '@pagespace/lib/services/agent-workspaces/workspace-membership-store';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getUserAccessLevel } from '@pagespace/lib/permissions/permissions';
import {
  compile,
  openConversation,
  openPage,
  type CommandResult,
} from '@pagespace/lib/agent-workspaces/workspace-node-commands';
import { move, resize } from '@pagespace/lib/agent-workspaces/workspace-node-algebra';
import { childrenOf, findNode, rootOf, type WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import { createId } from '@paralleldrive/cuid2';
import { applyWorkspaceNodeCommand } from './workspace-node-runtime';

/**
 * A rearrange's answer. It REPORTS, unlike the placement helpers: a rearrange is
 * something the model asked for explicitly and must be told the truth about,
 * where a placement is a courtesy riding along on other work. It still never
 * throws — the caller maps the result to a tool answer.
 */
export type LayoutCommandOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; reason: string };

/**
 * Run ONE command against a workspace, atomically.
 *
 * The command's compiled operations are one write: a step that is refused ends
 * the command with that refusal and nothing is persisted, so the grid is never
 * left half-rearranged.
 */
export async function applyLayoutCommandForWorkspace(input: {
  workspaceId: string;
  actingUserId: string;
  run: (nodes: readonly WorkspaceNode[]) => CommandResult;
}): Promise<LayoutCommandOutcome> {
  try {
    const result = await applyWorkspaceNodeCommand(input);
    if (result.status === 'ok') return { ok: true, changed: result.changed };
    if (result.status === 'refused') return { ok: false, reason: result.code };
    // A conversation already shown by a node in ANOTHER workspace. Reported by
    // its code like any other refusal — a tool caller has no snapshot to rebase
    // onto (it holds none; the command was resolved under the lock), so the
    // rebase body the HTTP route needs is not something this path can use. It
    // is named rather than falling through, because the fall-through below says
    // `stale`, and reporting a real domain refusal as a contended workspace
    // would send an agent retrying a write that can never succeed.
    if (result.status === 'conflict') return { ok: false, reason: result.code };
    // Unreachable: a command's `baseRev` IS the rev the lock read, so there is
    // no snapshot for it to be stale against. Named rather than collapsed into
    // the refusal above, because a `stale` arriving here would mean the funnel
    // stopped deciding under the lock, and that should read as a bug and not as
    // a contended workspace.
    return { ok: false, reason: 'stale' };
  } catch (error) {
    loggers.api.error(
      'Agent layout command failed',
      error instanceof Error ? error : undefined,
      { workspaceId: input.workspaceId },
    );
    return { ok: false, reason: 'failed' };
  }
}

// ---------------------------------------------------------------------------
// Placement — open_page_pane and spawn_session
// ---------------------------------------------------------------------------

/**
 * The workspace whose tree holds this conversation, or `null` for a thread that
 * belongs to none.
 *
 * One lookup on the node table's global chat-target index — the membership
 * read, where this used to select `conversations.workspaceId`.
 */
async function findWorkspaceOfConversation(conversationId: string): Promise<string | null> {
  return findWorkspaceOfChat(db, conversationId);
}

/**
 * `open_page_pane`'s server half: show `pageId` in the grid of whatever
 * workspace the invoking conversation belongs to. A conversation bound to no
 * workspace (a plain page chat, the global assistant outside a session) has no
 * grid, and this is a no-op — exactly as the tool's doc promises.
 */
export async function placePagePaneForConversation(input: {
  conversationId: string;
  pageId: string;
  /** The ACTING USER — the page ACL is checked against them, never the model's word. */
  viewerId: string;
}): Promise<void> {
  try {
    const workspaceId = await findWorkspaceOfConversation(input.conversationId);
    if (!workspaceId) return;

    // THE GATE (security review, MEDIUM on the HIGH 1 surface). `pageId` comes
    // from the MODEL, and a prompt-injected agent naming ids it should not know
    // must not be able to turn this into a page-title exfiltration channel — the
    // title would land in the response of every later reader of this grid. The
    // acting user's own page access is the only thing that decides.
    //
    // It is checked HERE as well as inside the write funnel, and that is not
    // redundancy for its own sake: this one refuses the whole placement quietly
    // and logs which page was named, where the funnel's gate is uniform and
    // deliberately says nothing. A prompt-injection attempt is exactly the thing
    // an operator needs to find in a log.
    if ((await getUserAccessLevel(input.viewerId, input.pageId)) === null) {
      loggers.api.warn('Refused a page-pane placement for a page the acting user cannot view', {
        conversationId: input.conversationId,
        pageId: input.pageId,
      });
      return;
    }

    // Deliberately no title lookup. The old helper read `pages.title` so the
    // broadcast would carry the right label; the node broadcast carries no
    // labels at all (it goes to a room, and a title is authority), and every
    // reader resolves the title through its own access-checked read. One less
    // query, and one less place a stale label can be written down.
    const outcome = await applyLayoutCommandForWorkspace({
      workspaceId,
      actingUserId: input.viewerId,
      run: (nodes) =>
        openPage(nodes, {
          target: { kind: 'page', id: input.pageId },
          newNodeId: createId(),
          newSplitId: createId(),
          // An agent ADDS a surface beside what the user is doing; it never
          // navigates their panes. Only an unbound picker pane may be filled.
          preferSplit: true,
          // The conversation that made the call must never be evicted by its own
          // tool call.
          excludeTargetId: input.conversationId,
        }),
    });
    if (!outcome.ok) {
      loggers.api.warn('Server-side page-pane placement was refused', {
        workspaceId,
        pageId: input.pageId,
        reason: outcome.reason,
      });
    }
  } catch (error) {
    loggers.api.error(
      'Could not place a page pane for a tool call',
      error instanceof Error ? error : undefined,
      { conversationId: input.conversationId, pageId: input.pageId },
    );
  }
}

/**
 * `spawn_session`'s server half: give the freshly spawned worker a pane in the
 * workspace it was placed into, so the user watches it work instead of
 * discovering it in a sidebar later. Same courtesy semantics as above — a
 * failure here never fails the spawn, which has already succeeded.
 */
export async function placeWorkerPane(input: {
  workspaceId: string;
  conversationId: string;
  /** The ACTING USER, for the binding gate. */
  actingUserId: string;
  /** The spawning conversation, when it is in the same grid — never evicted by its own spawn. */
  excludeTargetId?: string;
}): Promise<void> {
  try {
    const outcome = await applyLayoutCommandForWorkspace({
      workspaceId: input.workspaceId,
      actingUserId: input.actingUserId,
      run: (nodes) =>
        openConversation(nodes, {
          target: { kind: 'chat', id: input.conversationId },
          newNodeId: createId(),
          newSplitId: createId(),
          preferSplit: true,
          ...(input.excludeTargetId === undefined ? {} : { excludeTargetId: input.excludeTargetId }),
        }),
    });
    if (!outcome.ok) {
      loggers.api.warn('Server-side worker-pane placement was refused', {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        reason: outcome.reason,
      });
    }
  } catch (error) {
    loggers.api.error(
      'Could not place a pane for a spawned worker',
      error instanceof Error ? error : undefined,
      { workspaceId: input.workspaceId, conversationId: input.conversationId },
    );
  }
}

// ---------------------------------------------------------------------------
// Rearrangement — the three layout tools
// ---------------------------------------------------------------------------

/** What a rearrange tool asked for. Compiled to the algebra by the builders below. */
export type LayoutCommandInput =
  | { type: 'resize'; nodeId: string; fraction: number }
  | { type: 'move'; nodeId: string; parentId: string | null; index?: number }
  | { type: 'arrange'; parentId?: string; nodeIds: readonly string[] };

/**
 * Compile a rearrange into a command resolved against the tree it will be
 * applied to.
 *
 * Every branch that needs to know something about the layout — where "append"
 * is, which node is the root — computes it from `nodes` HERE rather than from a
 * snapshot the caller read earlier. That is the whole point of a server-resolved
 * command: the tree it is decided against is the tree it commits against.
 */
export function layoutCommand(
  command: LayoutCommandInput,
): (nodes: readonly WorkspaceNode[]) => CommandResult {
  return (nodes) => {
    switch (command.type) {
      case 'resize':
        return resize(nodes, { nodeId: command.nodeId, fraction: command.fraction });

      case 'move': {
        // Omitted index means LAST, and it is computed rather than guessed: the
        // algebra REFUSES an out-of-range slot instead of clamping it (a clamp
        // turns a caller working from a stale layout into a caller that got what
        // it asked for somewhere else, silently), so "append" has to be a real
        // slot in the destination as it is right now. Measured with the mover
        // discounted, because `move` indexes the group it is arriving in.
        const destination =
          command.parentId === null
            ? nodes.filter((node) => node.nodeType === 'pane' && node.parentId === null)
            : childrenOf(nodes, command.parentId);
        const append = destination.filter((sibling) => sibling.id !== command.nodeId).length;
        return move(nodes, {
          nodeId: command.nodeId,
          parentId: command.parentId,
          index: command.index ?? append,
        });
      }

      case 'arrange': {
        // Omitted parent means the ROOT's own children — the top-level order,
        // which is what `reorder_columns` meant when the model was two levels
        // deep and the root was the grid. Found BY TYPE, never as "the node with
        // no parent": a parked pane has none either.
        const root = rootOf(nodes);
        const parentId = command.parentId ?? root?.id;
        if (parentId === undefined) {
          return { ok: false, code: 'no_root', detail: 'this workspace has no root to reorder' };
        }
        if (findNode(nodes, parentId) === undefined) {
          return { ok: false, code: 'unknown_parent', detail: `no node "${parentId}" to rearrange` };
        }
        const present = new Set(childrenOf(nodes, parentId).map((child) => child.id));
        // Named ids go first in the order given; every child left out keeps its
        // relative position behind them — `reorder_columns`' rule, and the
        // reason a model can say "put the terminal first" without enumerating
        // the rest.
        //
        // An id that is not a child of this container is SKIPPED rather than
        // refused, also as before: ids change as panes open and close, and
        // failing a whole rearrange because one of four went stale would make
        // the tool unusable exactly when a workspace is busy. That is a policy
        // decision about a model's ergonomics, which is what this layer is for
        // — it is emphatically NOT the algebra clamping a bad index, which
        // stays refused.
        const named = command.nodeIds.filter((id) => present.has(id));
        // Moving to slot `i` in ascending `i` leaves the unnamed children
        // trailing in their existing relative order, because a `move` is an
        // extraction and a re-insertion and never touches anyone it did not
        // pass. Compiled, so the whole reorder is ONE write: no intermediate
        // tree is ever published, and a refused step leaves the layout untouched.
        return compile(
          nodes,
          named.map((id, index) => (current: readonly WorkspaceNode[]) =>
            move(current, { nodeId: id, parentId, index }),
          ),
        );
      }
    }
  };
}

/**
 * SERVER-SIDE pane placement — how an agent puts something in front of a user
 * (epic Phase 3).
 *
 * This capability is new. In the blob era the pane grid's only writer was
 * client → debounced PUT → `saveSessionWorkspace`, so a server-side action
 * could not place a pane at all: `open_page_pane` merely acked and whichever
 * browsers happened to be rendering that grid reacted to the streamed tool
 * result. A grid nobody had open saw nothing, ever. Now placement is a real
 * `open_conversation` verb against the relational rows, which means it
 * survives (the pane is simply there when the grid is opened an hour later)
 * AND arrives live (`workspace:updated` on the `session:<id>` room).
 *
 * **Never throws.** A layout write is a courtesy on top of the model's actual
 * work; failing a turn because a pane could not be placed would be a strictly
 * worse outcome than the pane not appearing. Every entry point here swallows
 * and logs.
 *
 * **Idempotent by construction.** Callers derive `opId` from the tool call id,
 * so an SDK retry of one tool call replays through the verb engine's op memory
 * instead of placing a second pane.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { pages } from '@pagespace/db/schema/core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import type { PaneScope } from '@pagespace/lib/agent-sessions/contract';
import { createId } from '@paralleldrive/cuid2';
import { applyWorkspaceLayoutVerb, readWorkspaceLayoutSnapshot } from './workspace-layout-runtime';

/**
 * Rebase attempts on a contended workspace. A verb POST from a browser owns
 * its own retry loop (the store's queue); this path has no queue to fall back
 * on, so it rebases here — three tries is plenty for "a user happened to
 * split a pane in the same instant", and giving up quietly is correct for a
 * courtesy write.
 */
const MAX_PLACEMENT_ATTEMPTS = 3;

/**
 * Apply one `open_conversation` verb, re-reading the rev and retrying while
 * the server answers `stale`. The `opId` is deliberately CONSTANT across
 * attempts: a rebase is the same op, and reusing the key is what stops a
 * retry from double-placing if an earlier attempt actually landed.
 */
async function placePane(input: {
  workspaceId: string;
  scope: PaneScope;
  opId: string;
  excludeTargetId?: string;
}): Promise<void> {
  for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS; attempt += 1) {
    const snapshot = await readWorkspaceLayoutSnapshot(input.workspaceId);
    const result = await applyWorkspaceLayoutVerb({
      workspaceId: input.workspaceId,
      opId: input.opId,
      baseRev: snapshot.rev,
      verb: {
        type: 'open_conversation',
        scope: input.scope,
        newColumnId: createId(),
        newPaneId: createId(),
        // An agent ADDS a surface beside what the user is doing; it never
        // navigates their panes. Only an unbound picker pane may be filled,
        // and the invoking conversation's own pane is never a candidate at
        // all — the same two guards the client store has applied to the
        // agent-driven `openPage` path since `open_page_pane` shipped.
        preferSplit: true,
        ...(input.excludeTargetId ? { excludeTargetId: input.excludeTargetId } : {}),
      },
    });
    if (result.status === 'ok') return;
  }
  loggers.api.warn('Server-side pane placement gave up after repeated rev conflicts', {
    workspaceId: input.workspaceId,
  });
}

/** The workspace a conversation is bound into, or `null` for an unbound thread. */
async function findWorkspaceOfConversation(conversationId: string): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: conversations.sessionId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row?.workspaceId ?? null;
}

/**
 * `open_page_pane`'s server half: show `pageId` in the grid of whatever
 * workspace the invoking conversation belongs to. A conversation bound to no
 * workspace (a plain page chat, the global assistant outside a session) has
 * no grid, and this is a no-op — exactly as the tool's doc promises.
 */
export async function placePagePaneForConversation(input: {
  conversationId: string;
  pageId: string;
  title?: string;
  opId: string;
}): Promise<void> {
  try {
    const workspaceId = await findWorkspaceOfConversation(input.conversationId);
    if (!workspaceId) return;

    // Prefer the page's REAL title over the model's label: the pane header is
    // display-only, but a wrong label is still a lie, and the row is one
    // query away. (The layout GET re-derives labels on read anyway — this
    // only decides what the broadcast carries in the meantime.)
    const [page] = await db
      .select({ title: pages.title })
      .from(pages)
      .where(eq(pages.id, input.pageId))
      .limit(1);

    await placePane({
      workspaceId,
      opId: input.opId,
      scope: { kind: 'page', name: page?.title ?? input.title ?? 'Page', targetId: input.pageId, agentPageId: null },
      // The conversation that made the call must never be evicted by its own
      // tool call.
      excludeTargetId: input.conversationId,
    });
  } catch (error) {
    loggers.api.error(
      'Could not place a page pane for a tool call',
      error instanceof Error ? error : undefined,
      { conversationId: input.conversationId, pageId: input.pageId },
    );
  }
}

/**
 * `spawn_session`'s server half: give the freshly spawned worker a pane in
 * the workspace it was placed into, so the user watches it work instead of
 * discovering it in a sidebar later. Same courtesy semantics as above — a
 * failure here never fails the spawn, which has already succeeded.
 */
export async function placeWorkerPane(input: {
  workspaceId: string;
  conversationId: string;
  name: string;
  agentPageId: string | null;
  opId: string;
  /** The spawning conversation, when it is in the same grid — never evicted by its own spawn. */
  excludeTargetId?: string;
}): Promise<void> {
  try {
    await placePane({
      workspaceId: input.workspaceId,
      opId: input.opId,
      scope: {
        kind: 'chat',
        name: input.name,
        targetId: input.conversationId,
        agentPageId: input.agentPageId,
      },
      excludeTargetId: input.excludeTargetId,
    });
  } catch (error) {
    loggers.api.error(
      'Could not place a pane for a spawned worker',
      error instanceof Error ? error : undefined,
      { workspaceId: input.workspaceId, conversationId: input.conversationId },
    );
  }
}

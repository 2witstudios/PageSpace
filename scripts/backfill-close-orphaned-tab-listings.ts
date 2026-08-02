import 'dotenv/config';
import { getMigrationDb } from '@pagespace/db/db';
import { agentSessions } from '@pagespace/db/schema/agent-sessions';
import { conversations } from '@pagespace/db/schema/conversations';
import { and, eq, isNull, sql } from '@pagespace/db/operators';

/**
 * One-shot cleanup for the pane-tabs removal: a pane used to be able to hold
 * several open conversations behind a switchable strip (`tabs: PaneScope[]`).
 * The runtime schema (`persistedPaneStateSchema`) now silently drops that
 * array on parse — by design, for the shape — but the BACKGROUND
 * conversations it used to name were never closed server-side. Left alone,
 * they keep counting against `MAX_SESSION_CONVERSATIONS` forever with no
 * pane pointing at them (review finding — chatgpt-codex-connector on
 * PR #2308).
 *
 * Safe by construction: a pane only ever had `tabs.length > 1` while its
 * ACTIVE tab (`scope`) was also one of those tabs, so the session always has
 * at least that one conversation open — closing only the OTHER (background)
 * tabs here can never trip the never-empty-session invariant
 * `closeConversationInSession` enforces for a live close. Idempotent: a
 * session already re-saved under the new tabs-less shape (or one that never
 * had a multi-tab pane) has nothing for this script to find.
 */
const db = getMigrationDb();

interface RawPaneScope {
  targetId: string | null;
}
interface RawPane {
  scope: RawPaneScope | null;
  tabs?: RawPaneScope[];
}
interface RawColumn {
  panes: RawPane[];
}
interface RawWorkspaceState {
  columns: RawColumn[];
}

async function main(): Promise<void> {
  const rows = await db
    .select({ id: agentSessions.id, workspaceState: agentSessions.workspaceState })
    .from(agentSessions)
    .where(sql`${agentSessions.workspaceState} IS NOT NULL`);

  let sessionsWithOrphans = 0;
  let closed = 0;
  let alreadyClosed = 0;

  for (const row of rows) {
    const workspace = row.workspaceState as unknown as RawWorkspaceState | null;
    if (!workspace?.columns) continue;

    const orphanTargetIds = new Set<string>();
    for (const column of workspace.columns) {
      for (const pane of column.panes ?? []) {
        if (!Array.isArray(pane.tabs) || pane.tabs.length <= 1) continue;
        const activeTargetId = pane.scope?.targetId ?? null;
        for (const tab of pane.tabs) {
          if (tab.targetId && tab.targetId !== activeTargetId) orphanTargetIds.add(tab.targetId);
        }
      }
    }
    if (orphanTargetIds.size === 0) continue;

    sessionsWithOrphans++;
    console.log(`  session ${row.id}: ${orphanTargetIds.size} orphaned background tab(s)`);

    for (const conversationId of orphanTargetIds) {
      // Scoped to THIS session — a conversation the client believed was a
      // background tab here but has since moved (a fork, or reopened
      // elsewhere) is not this script's business to touch.
      const updated = await db
        .update(conversations)
        .set({ closedInSessionAt: new Date() })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.sessionId, row.id),
            isNull(conversations.closedInSessionAt),
          ),
        )
        .returning({ id: conversations.id });
      if (updated.length > 0) closed++;
      else alreadyClosed++;
    }
  }

  console.log(
    `\nDone. ${sessionsWithOrphans} session(s) had orphaned background tabs; ${closed} conversation(s) closed, ${alreadyClosed} already closed/moved.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exit(1);
  });

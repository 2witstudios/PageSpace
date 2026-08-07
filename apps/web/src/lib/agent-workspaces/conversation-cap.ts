/**
 * The ONE open-conversation count for a workspace (`agent_workspaces` row).
 *
 * "Open" means exactly: bound to this workspace (`conversations.workspaceId`),
 * history-alive (`isActive`), and not closed out of the workspace's listing
 * (`closedInWorkspaceAt IS NULL`). This single predicate is what
 * `MAX_SESSION_CONVERSATIONS` bounds everywhere it is enforced — the claim
 * path's cap, the close/reopen symmetry, the tool layer's advisory spawn
 * pre-count, and the end-session warning — and it used to be written out
 * three times, which is three chances for one copy to silently drift and
 * unbalance which listings count toward the cap (epic Phase 1, D7).
 *
 * `executor` defaults to the plain `db`; a caller holding its own connection
 * (a transaction, a lock-scoped client) passes that instead of this module
 * reaching for the shared pool underneath it.
 */

import { db } from '@pagespace/db/db';
import { and, count, eq, isNull } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';

/** The slice of a Drizzle client this count needs — satisfied by `db` and by a transaction alike. */
type CountExecutor = Pick<typeof db, 'select'>;

export async function countOpenConversations(
  workspaceId: string,
  executor: CountExecutor = db,
): Promise<number> {
  const [row] = await executor
    .select({ n: count() })
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.isActive, true),
        isNull(conversations.closedInWorkspaceAt),
      ),
    );
  return row?.n ?? 0;
}

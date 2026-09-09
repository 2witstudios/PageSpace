/**
 * The ONE conversation count for a workspace — how many threads it HOLDS.
 *
 * "Holds" means exactly: a node of this workspace's tree is bound to the
 * conversation. That is the whole definition now, and it is one predicate over
 * one table rather than the three-column conjunction it replaces
 * (`workspaceId` + `isActive` + `closedInWorkspaceAt IS NULL`), which had to be
 * kept identical at four call sites or the cap silently drifted from the
 * listing it was meant to bound (epic Phase 1, D7).
 *
 * **Two things it deliberately does NOT do:**
 *
 *  - **It does not filter by `isActive`.** A history-deleted thread has its
 *    node removed by the delete itself (`expelConversationFromSession`), so
 *    "gone from history" and "gone from the workspace" are one write rather
 *    than two conditions a reader has to AND together.
 *  - **It does not enforce the cap.** `admit` does, counting the tree inside
 *    the same locked transaction that writes it — so the ceiling cannot be
 *    crossed by two callers who each read a number a moment earlier. This
 *    function exists for the surfaces that want to TELL a user something before
 *    they act, which is a different job with a different tolerance for being a
 *    moment out of date.
 */

import { db } from '@pagespace/db/db';
import { countChatMembers } from '@pagespace/lib/services/agent-workspaces/workspace-membership-store';

/** The slice of a Drizzle client this count needs — satisfied by `db` and by a transaction alike. */
type CountExecutor = Pick<typeof db, 'select'>;

export async function countOpenConversations(
  workspaceId: string,
  executor: CountExecutor = db,
): Promise<number> {
  return countChatMembers(executor, workspaceId);
}

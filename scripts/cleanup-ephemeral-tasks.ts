import 'dotenv/config';
import { getMigrationDb } from '@pagespace/db/db';
import { taskLists } from '@pagespace/db/schema/tasks';
import { and, isNull, isNotNull } from '@pagespace/db/operators';

// One-shot ops script — runs on the unthrottled migration pool, not the
// app-throttled `db` (see getMigrationDb()'s doc comment in packages/db).
const db = getMigrationDb();

/**
 * Cleanup script to remove ephemeral (conversation-scoped) task lists.
 *
 * These were used for AI workflow tracking but are being removed in favor
 * of page-based task lists only. Ephemeral task lists are identified by:
 * - page_id IS NULL (not linked to a page)
 * - conversation_id IS NOT NULL (was conversation-scoped)
 *
 * Run with: bun scripts/cleanup-ephemeral-tasks.ts
 * Or in Docker: docker exec <container> bun scripts/cleanup-ephemeral-tasks.ts
 */
async function cleanup(): Promise<void> {
  console.log('Starting ephemeral task list cleanup...');

  // First, count what we're about to delete
  const ephemeralLists = await db
    .select({ id: taskLists.id })
    .from(taskLists)
    .where(and(
      isNull(taskLists.pageId),
      isNotNull(taskLists.conversationId)
    ));

  const listIds = ephemeralLists.map(l => l.id);
  console.log(`Found ${listIds.length} ephemeral task list(s) to clean up`);

  if (listIds.length === 0) {
    console.log('No ephemeral task lists found. Nothing to clean up.');
    return;
  }

  // Delete the task lists (task items for ephemeral lists are now orphaned since
  // taskItems no longer has a taskListId FK — they'll be cleaned by a separate orphan sweep)
  await db.transaction(async (tx) => {
    const deletedLists = await tx
      .delete(taskLists)
      .where(and(
        isNull(taskLists.pageId),
        isNotNull(taskLists.conversationId)
      ))
      .returning({ id: taskLists.id });

    console.log(`Deleted ${deletedLists.length} task list(s)`);
  });

  console.log('Cleanup complete!');
}

cleanup()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Cleanup failed:', error);
    process.exit(1);
  });

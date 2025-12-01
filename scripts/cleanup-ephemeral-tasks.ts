import 'dotenv/config';
import { db, taskLists, taskItems, eq, and, isNull, isNotNull, sql } from '@pagespace/db';

/**
 * Cleanup script to remove ephemeral (conversation-scoped) task lists.
 *
 * These were used for AI workflow tracking but are being removed in favor
 * of page-based task lists only. Ephemeral task lists are identified by:
 * - page_id IS NULL (not linked to a page)
 * - conversation_id IS NOT NULL (was conversation-scoped)
 *
 * Run with: pnpm tsx scripts/cleanup-ephemeral-tasks.ts
 * Or in Docker: docker exec <container> pnpm tsx scripts/cleanup-ephemeral-tasks.ts
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

  // Count task items that will be deleted
  const taskCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taskItems)
    .where(sql`${taskItems.taskListId} = ANY(${listIds})`);

  console.log(`Will delete ${taskCount[0]?.count ?? 0} task item(s)`);

  // Perform the cleanup in a transaction
  await db.transaction(async (tx) => {
    // Delete task items first (foreign key constraint)
    const deletedItems = await tx
      .delete(taskItems)
      .where(sql`${taskItems.taskListId} = ANY(${listIds})`)
      .returning({ id: taskItems.id });

    console.log(`Deleted ${deletedItems.length} task item(s)`);

    // Delete the task lists
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

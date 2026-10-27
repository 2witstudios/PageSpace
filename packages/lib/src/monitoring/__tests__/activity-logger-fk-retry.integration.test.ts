/**
 * Activity-log pageId FK retry — integration tests (Postgres)
 *
 * Tests against a real Postgres database. FAILS LOUDLY when no DB is reachable — a silent skip
 * would be a green, zero-assertion pass. Local runs without Docker opt out
 * explicitly with ALLOW_SKIP_DB_TESTS=1.
 *
 * The unit tests for `isPageIdForeignKeyError` construct the Drizzle wrapper
 * error by hand, so they can only prove the predicate matches the shape we
 * *believe* Drizzle throws. These tests remove that assumption: a real FK
 * violation is provoked against a real `activity_logs` table, wrapped by the
 * real driver, and the retry either fires or it does not.
 *
 * This is the regression that matters. The previous top-level-only guard
 * passed every hand-built unit test while never firing in production.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { factories } from '@pagespace/db/test/factories';
import { logActivity, logMessageActivity } from '../activity-logger';
import { requireDb } from '@pagespace/db/test/require-db';

let dbAvailable = false;

beforeAll(async () => {
  try {
    await db.execute(sql`SELECT 1`);
    dbAvailable = true;
  } catch (error) {
    requireDb('activity-logger-fk-retry.integration.test.ts', error);
    dbAvailable = false;
  }
});

/**
 * Read back the single row a test wrote, keyed by its unique resourceId.
 *
 * Activity logging is fire-and-forget, so the write may still be in flight when
 * the caller returns. Poll rather than sleeping a fixed interval: a macrotask
 * yield does not wait on a database round-trip, and a fixed sleep long enough
 * to be safe on CI would be dead time on every run.
 *
 * Returns undefined once the budget is exhausted so the "row is absent" case
 * stays assertable — it just costs the full budget to prove.
 */
async function readRowByResourceId(resourceId: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db.query.activityLogs.findFirst({
      where: eq(activityLogs.resourceId, resourceId),
    });
    if (row || Date.now() >= deadline) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('activity-log pageId FK retry (Postgres)', () => {
  it('persists the row against a real page, keeping the pageId', async () => {
    if (!dbAvailable) return;

    const user = await factories.createUser();
    const drive = await factories.createDrive(user.id);
    const page = await factories.createPage(drive.id);
    const resourceId = createId();

    await logActivity({
      userId: user.id,
      actorEmail: user.email,
      operation: 'update',
      resourceType: 'page',
      resourceId,
      driveId: drive.id,
      pageId: page.id,
    });

    const row = await readRowByResourceId(resourceId);
    expect(row?.pageId).toBe(page.id);
  });

  it('still records the activity when the page is gone, dropping only the pageId', async () => {
    if (!dbAvailable) return;

    const user = await factories.createUser();
    const drive = await factories.createDrive(user.id);
    const resourceId = createId();

    // A page id that is well-formed but absent from `pages` — exactly the state
    // left behind when a page is deleted mid-log. Postgres raises 23503, and
    // node-postgres' error is wrapped by DrizzleQueryError with the pg fields
    // reachable only via `.cause`.
    await logActivity({
      userId: user.id,
      actorEmail: user.email,
      operation: 'update',
      resourceType: 'page',
      resourceId,
      driveId: drive.id,
      pageId: createId(),
    });

    const row = await readRowByResourceId(resourceId);
    // Before the fix this row did not exist at all: the FK guard never matched
    // the wrapped error, so the retry was skipped and the insert was dropped.
    expect(row).toBeDefined();
    expect(row?.pageId).toBeNull();
    expect(row?.driveId).toBe(drive.id);
  });

  it('records a global-assistant message edit, which has no backing page', async () => {
    if (!dbAvailable) return;

    const user = await factories.createUser();
    const messageId = createId();
    const conversationId = createId();

    // How the Global Assistant route logs today: user-level, not page-backed.
    // Passing `conversationId` here as `pageId` is what caused the FK violation.
    logMessageActivity(
      user.id,
      'message_delete',
      { id: messageId, pageId: null, driveId: null, conversationType: 'global' },
      { actorEmail: user.email },
      { previousContent: 'deleted text', aiConversationId: conversationId }
    );

    const row = await readRowByResourceId(messageId);
    expect(row).toBeDefined();
    expect(row?.pageId).toBeNull();
    expect(row?.driveId).toBeNull();
    expect(row?.aiConversationId).toBe(conversationId);
    expect((row?.metadata as Record<string, unknown>)?.conversationType).toBe('global');
  });
});

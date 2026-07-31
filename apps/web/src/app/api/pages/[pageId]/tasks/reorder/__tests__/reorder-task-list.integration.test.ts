/**
 * reorderTaskListChildren concurrency integration test (real Postgres).
 *
 * Requirement: Given a reorder transaction has locked the scope of a task
 * list's TASK_LIST child pages via reorderTaskListChildren, when a
 * concurrent transaction attempts to trash one of those pages, the trash
 * update should block until the reorder transaction commits — so
 * lockedBatchReorder's two statements (SELECT ... FOR UPDATE, then the
 * batched UPDATE) observe the same scope instead of racing under READ
 * COMMITTED. Without the FOR SHARE lock this closes, a page trashed in the
 * gap between those two statements leaves a task reported as "locked" (and
 * the route reports success) while its position was silently never written.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). Skipped when no DB is reachable —
 * mirrors packages/lib/src/services/reorder/__tests__/locked-batch-reorder.integration.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { taskItems } from '@pagespace/db/schema/tasks';
import { factories } from '@pagespace/db/test/factories';
import { computeReorderPlan } from '@pagespace/lib/services/reorder';
import { reorderTaskListChildren } from '../reorder-task-list';

let dbAvailable = false;

/**
 * Polls pg_locks (from a separate connection than the one holding the lock)
 * until `backendPid` is observed actually holding a granted lock on `pages`.
 * A fixed sleep-then-fire "head start" would make this test's pass/fail
 * depend on whether that guess happened to be long enough under whatever
 * load the CI runner is under that day — this instead confirms the lock is
 * held before the concurrent trash attempt fires, so the test is
 * deterministic rather than timing-guessed.
 */
async function waitForPagesLock(backendPid: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // mode = 'RowShareLock' is specifically the lock FOR SHARE/FOR UPDATE
    // selects take — a plain unlocked SELECT only ever takes the much
    // weaker, always-present AccessShareLock, so filtering by mode is what
    // makes this a genuine proof that reorderTaskListChildren's FOR SHARE
    // ran, not just that some connection touched the pages table.
    const result = await db.execute(sql`
      SELECT 1 FROM pg_locks
      WHERE pid = ${backendPid} AND relation = 'pages'::regclass AND mode = 'RowShareLock' AND granted = true
      LIMIT 1
    `);
    if (result.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for backend ${backendPid} to hold a lock on pages`);
}

describe('reorderTaskListChildren concurrency (Postgres row lock)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it('blocks a concurrent page trash until the reorder transaction commits', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const taskListPage = await factories.createPage(drive.id, { type: 'FOLDER' });
    const childPage = await factories.createPage(drive.id, {
      parentId: taskListPage.id,
      type: 'TASK_LIST',
      isTrashed: false,
    });
    const [task] = await db.insert(taskItems).values({
      userId: owner.id,
      pageId: childPage.id,
    }).returning();

    const HOLD_MS = 500;
    let backendPid: number | undefined;

    // A fractional position also proves the `real` cast: an ::int cast would store 9.
    const plan = computeReorderPlan([{ id: task.id, position: 9.5 }]);
    const reorderPromise = db.transaction(async (tx) => {
      const pidResult = await tx.execute(sql`SELECT pg_backend_pid() as pid`);
      backendPid = (pidResult.rows[0] as { pid: number }).pid;
      const lockedIds = await reorderTaskListChildren(tx, taskListPage.id, plan);
      // Hold the FOR SHARE lock open for a measurable window so the
      // concurrent trash attempt below is provably blocked, not just fast.
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      return lockedIds;
    });

    // Wait until the reorder transaction is actually observed holding its
    // lock (not a fixed delay guess) before firing the concurrent trash.
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the transaction above start executing
    while (backendPid === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await waitForPagesLock(backendPid);

    const trashStart = performance.now();
    await db.update(pages).set({ isTrashed: true }).where(eq(pages.id, childPage.id));
    const trashDurationMs = performance.now() - trashStart;

    const lockedIds = await reorderPromise;

    // The trash UPDATE must have waited for the reorder transaction's SHARE
    // lock to release — without the fix it would return almost immediately.
    expect(trashDurationMs).toBeGreaterThanOrEqual(HOLD_MS - 100);

    // The reorder itself still succeeded: the task was in scope for the
    // entire transaction (locked before the trash committed), so it must be
    // reported as locked/updated rather than silently dropped.
    expect(lockedIds).toEqual([task.id]);

    // The write lands on pages.position — the single ordering rail (#2143) — with the
    // fraction intact.
    const [updatedPage] = await db.select().from(pages).where(eq(pages.id, childPage.id));
    expect(updatedPage.position).toBe(9.5);
    expect(updatedPage.isTrashed).toBe(true);
  });
});

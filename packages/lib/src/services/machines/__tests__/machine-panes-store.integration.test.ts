/**
 * Machine Panes Store Integration Tests (Postgres)
 *
 * Tests against a real Postgres database. Skips gracefully when DB is
 * unavailable — same convention as `distributed-rate-limit.integration.test.ts`.
 *
 * Exercises `withMachineLock` end to end: two concurrent read-reduce-write
 * cycles for the SAME workspace must not lose either one's addition. Without
 * the per-machine advisory lock serializing the whole cycle (not just
 * `replaceWorkspaceGrid`'s own internal transaction), both callers can read
 * the same pre-mutation grid and the later commit silently discards the
 * earlier one's write — see `machine-panes-store.ts`'s module doc.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';
import { machineWorkspaces } from '@pagespace/db/schema/machine-workspaces';
import { factories } from '@pagespace/db/test/factories';
import { createDbMachinePanesStore, withMachineLock, type WorkspaceGridColumnInput } from '../machine-panes-store';

let dbAvailable = false;

beforeAll(async () => {
  try {
    await db.execute(sql`SELECT 1`);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

/** One column holding one bound pane, named so each concurrent writer's
 * addition is independently identifiable in the final grid. */
function columnFor(name: string): WorkspaceGridColumnInput {
  return { id: `col-${name}`, panes: [{ id: `pane-${name}`, scope: { name } }] };
}

describe('machine-panes-store integration (Postgres): withMachineLock', () => {
  it('two concurrent read-reduce-write cycles for the SAME workspace both survive — no lost update', async () => {
    if (!dbAvailable) return;

    const user = await factories.createUser();
    const drive = await factories.createDrive(user.id);
    const machine = await factories.createPage(drive.id, { type: 'MACHINE' as never });
    const workspaceId = createId();
    await db.insert(machineWorkspaces).values({
      id: workspaceId,
      ownerId: user.id,
      machineId: machine.id,
      scope: 'machine',
      name: 'Race Test Workspace',
      layout: { columns: [] },
    });

    // Each "critical section" mirrors `applyWorkspaceVerb`'s read-reduce-write
    // shape: read the CURRENT grid, append its own column, write the WHOLE
    // grid back. Run concurrently under `withMachineLock` — the lock must
    // serialize them so the second writer's read reflects the first's commit.
    async function addColumnUnderLock(columnName: string): Promise<void> {
      await withMachineLock(machine.id, async (tx) => {
        const store = await createDbMachinePanesStore(tx);
        const current = await store.getWorkspaceGrid(machine.id, workspaceId);
        await store.replaceWorkspaceGrid({
          machineId: machine.id,
          workspaceId,
          grid: [...current, columnFor(columnName)],
        });
      });
    }

    await Promise.all([addColumnUnderLock('a'), addColumnUnderLock('b')]);

    const finalStore = await createDbMachinePanesStore();
    const finalGrid = await finalStore.getWorkspaceGrid(machine.id, workspaceId);

    expect(finalGrid.map((c) => c.id).sort()).toEqual(['col-a', 'col-b']);
  }, 20_000);

  it('without the lock (unserialized concurrent writes to the SAME workspace), a lost update IS reproducible — pins the bug this fix closes', async () => {
    if (!dbAvailable) return;

    const user = await factories.createUser();
    const drive = await factories.createDrive(user.id);
    const machine = await factories.createPage(drive.id, { type: 'MACHINE' as never });
    const workspaceId = createId();
    await db.insert(machineWorkspaces).values({
      id: workspaceId,
      ownerId: user.id,
      machineId: machine.id,
      scope: 'machine',
      name: 'Unlocked Race Test Workspace',
      layout: { columns: [] },
    });

    // Deliberately WITHOUT withMachineLock — each caller reads and writes
    // through its own unserialized replaceWorkspaceGrid call, reproducing the
    // exact structure `applyWorkspaceVerb` had before this fix.
    //
    // Both reads happen FIRST, sequentially, before either write — a fresh
    // connection pool's first couple of acquisitions have their own setup
    // jitter (a brand-new connection vs. a warm reused one), and letting that
    // jitter leak into a "concurrent" read+write cycle non-deterministically
    // decided which writer's read/write pair actually finished first, not
    // the race this test exists to pin. With both reads resolved up front
    // (both see the same empty grid — neither has written yet), only the
    // WRITE side races: 'a' writes back immediately, 'b' waits long enough
    // that 'a's write is guaranteed to have already committed. 'b's blind
    // DELETE-by-workspaceId then deterministically discards 'a's
    // already-committed row while inserting from 'b's own stale pre-'a'
    // read — the exact lost-update shape this test exists to pin.
    const store = await createDbMachinePanesStore();
    const currentForA = await store.getWorkspaceGrid(machine.id, workspaceId);
    const currentForB = await store.getWorkspaceGrid(machine.id, workspaceId);

    async function writeColumn(columnName: string, current: WorkspaceGridColumnInput[], delayMs: number): Promise<void> {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      await store.replaceWorkspaceGrid({
        machineId: machine.id,
        workspaceId,
        grid: [...current, columnFor(columnName)],
      });
    }

    await Promise.all([writeColumn('a', currentForA, 0), writeColumn('b', currentForB, 100)]);

    const finalStore = await createDbMachinePanesStore();
    const finalGrid = await finalStore.getWorkspaceGrid(machine.id, workspaceId);

    // Exactly ONE survives — the later committer's blanket replace discarded
    // the earlier one's addition. This is the bug; the previous test is the fix.
    expect(finalGrid.length).toBe(1);
  }, 20_000);
});

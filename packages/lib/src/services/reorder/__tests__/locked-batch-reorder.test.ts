import { describe, it, expect, vi } from 'vitest';
import { eq } from '@pagespace/db/operators';
import { driveRoles } from '@pagespace/db/schema/members';
import { lockedBatchReorder } from '../locked-batch-reorder';

describe('lockedBatchReorder (empty-plan no-op)', () => {
  it('never touches the transaction when the plan has no ids', async () => {
    const select = vi.fn();
    const execute = vi.fn();
    // Minimal structural stand-in for Tx — this test only proves the empty-plan
    // guard short-circuits before any transaction call; real locking/update
    // behavior is proven against a real database in
    // locked-batch-reorder.integration.test.ts.
    const tx = { select, execute } as unknown as Parameters<typeof lockedBatchReorder>[0];

    const lockedIds = await lockedBatchReorder(tx, {
      table: driveRoles,
      idColumn: driveRoles.id,
      positionColumn: driveRoles.position,
      scopeWhere: eq(driveRoles.driveId, 'drive-1'),
      plan: { orderedIds: [], positionById: new Map() },
    });

    expect(select).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(lockedIds).toEqual([]);
  });
});

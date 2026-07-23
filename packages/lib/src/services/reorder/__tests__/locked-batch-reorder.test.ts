import { describe, it, expect, vi } from 'vitest';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { driveRoles } from '@pagespace/db/schema/members';
import { lockedBatchReorder } from '../locked-batch-reorder';

/**
 * Collect the literal SQL fragments from a Drizzle SQL object, however deeply nested.
 * Bound parameters carry a `value` too, so they are skipped by their `encoder` marker —
 * only StringChunk's `value: string[]` is literal SQL text.
 */
function collectSqlText(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectSqlText(child, out);
  } else if (node && typeof node === 'object') {
    const candidate = node as { queryChunks?: unknown; value?: unknown; encoder?: unknown };
    if (candidate.queryChunks) collectSqlText(candidate.queryChunks, out);
    if (candidate.encoder === undefined && Array.isArray(candidate.value)) {
      for (const part of candidate.value) {
        if (typeof part === 'string') out.push(part);
      }
    }
  }
  return out;
}

/** Minimal structural stand-in for Tx that records the UPDATE statement it is handed. */
function fakeTx(lockedIds: string[]) {
  const execute = vi.fn();
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    for: () => Promise.resolve(lockedIds.map((id) => ({ id }))),
  };
  const tx = {
    select: vi.fn(() => chain),
    execute,
  } as unknown as Parameters<typeof lockedBatchReorder>[0];
  return { tx, execute };
}

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

describe('lockedBatchReorder (position column type)', () => {
  const plan = { orderedIds: ['a'], positionById: new Map([['a', 1.5]]) };

  it('casts positions to int by default, matching integer position columns', async () => {
    const { tx, execute } = fakeTx(['a']);

    await lockedBatchReorder(tx, {
      table: driveRoles,
      idColumn: driveRoles.id,
      positionColumn: driveRoles.position,
      scopeWhere: eq(driveRoles.driveId, 'drive-1'),
      plan,
    });

    const text = collectSqlText(execute.mock.calls[0][0]).join('');
    expect(text).toContain('::int');
    expect(text).not.toContain('::real');
  });

  it('casts positions to real when the target column is a float, so fractions survive', async () => {
    // pages.position is `real`: an ::int cast would truncate every midpoint a task
    // reorder computes, collapsing distinct slots onto the same position.
    const { tx, execute } = fakeTx(['a']);

    await lockedBatchReorder(tx, {
      table: pages,
      idColumn: pages.id,
      positionColumn: pages.position,
      scopeWhere: eq(pages.parentId, 'page-1'),
      plan,
      positionType: 'real',
    });

    const text = collectSqlText(execute.mock.calls[0][0]).join('');
    expect(text).toContain('::real');
    expect(text).not.toContain('::int');
  });
});

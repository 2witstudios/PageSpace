/**
 * @scaffold — findOrphanedFileRecords, isFileOrphaned, and deleteFileRecords
 * all use raw SQL (db.execute / tx.execute), which is a clean boundary mock.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

import {
  findOrphanedFileRecords,
  isFileOrphaned,
  deleteFileRecords,
} from './orphan-detector';

type SqlNode = { strings: TemplateStringsArray; values: unknown[] };

// Recursively flattens the mocked sql`` tag's nested fragments (e.g. the
// shared REFERENCE_JOINS/IS_UNREFERENCED/NO_LIVE_SIBLING_SHARES_BLOB
// fragments interpolated into a parent query) into one full SQL string, so
// substring/regex assertions below can see the composed query, not just the
// outermost template's literal segments.
function sqlText(node: unknown): string {
  if (node && typeof node === 'object' && 'strings' in node) {
    const { strings, values } = node as SqlNode;
    return strings.reduce<string>(
      (acc, str, i) => acc + str + (i < values.length ? sqlText(values[i]) : ''),
      '',
    );
  }
  return '';
}

describe('findOrphanedFileRecords', () => {
  it('given_orphanedFilesExist_returnsAllWithParsedSizeBytes', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { id: 'f1', storagePath: '/path/f1', driveId: 'd1', sizeBytes: 1024 },
          { id: 'f2', storagePath: null, driveId: 'd1', sizeBytes: '2048' },
        ],
      }),
    };

    const result = await findOrphanedFileRecords(db as never);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 'f1', storagePath: '/path/f1', driveId: 'd1', sizeBytes: 1024 });
    expect(result[1].sizeBytes).toBe(2048);
  });

  it('given_noOrphans_returnsEmptyArray', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    const result = await findOrphanedFileRecords(db as never);

    expect(result).toEqual([]);
  });

  it('given_numericSizeBytes_preservesAsIs', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ id: 'f1', storagePath: '/p', driveId: 'd1', sizeBytes: 512 }],
      }),
    };

    const result = await findOrphanedFileRecords(db as never);

    expect(result[0].sizeBytes).toBe(512);
  });

  it('given_databaseError_propagates', async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error('connection refused')),
    };

    await expect(findOrphanedFileRecords(db as never)).rejects.toThrow('connection refused');
  });

  it('given_emptyRestrictToFileIds_returnsEmptyWithoutQueryingDB', async () => {
    // A scoped reap with no candidate files must scan NOTHING — never fall
    // through to a full-table sweep inside a user-facing request.
    const db = { execute: vi.fn() };

    const result = await findOrphanedFileRecords(db as never, []);

    expect(result).toEqual([]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('given_restrictToFileIds_scopesQueryWithIdFilterAndReturnsRows', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ id: 'f1', storagePath: '/p', driveId: 'd1', sizeBytes: 1024, createdBy: 'u1' }],
      }),
    };

    const result = await findOrphanedFileRecords(db as never, ['f1', 'f2']);

    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { id: 'f1', storagePath: '/p', driveId: 'd1', sizeBytes: 1024, createdBy: 'u1' },
    ]);
    // The restriction fragment must be interpolated into the executed SQL.
    const fullSql = sqlText(db.execute.mock.calls[0][0]);
    expect(fullSql).toContain('= ANY(');
  });

  it('given_sharedStoragePathDedupRequired_queryIncludesStoragePathGuard', async () => {
    // Ensures the SQL excludes blobs shared with a live sibling file record (#905 gap).
    // Uses storagePath (the actual CAS key in the files schema) — no contentHash column exists.
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await findOrphanedFileRecords(db as never);

    const fullSql = sqlText(db.execute.mock.calls[0][0]);
    expect(fullSql).toContain('storagePath');
    expect(fullSql).toContain('other_f');
  });

  it('given_dmLinkageTablesExist_queryReferencesFileConversationsAndDirectMessages', async () => {
    // Locks in the predicate so a file with a live DM linkage is never deleted.
    // Without these joins, polymorphic uploads (PR #6 of the DM-files epic) silently
    // become harvest targets for the cleanup cron.
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await findOrphanedFileRecords(db as never);

    const fullSql = sqlText(db.execute.mock.calls[0][0]);
    expect(fullSql).toContain('file_conversations');
    expect(fullSql).toContain('direct_messages');
  });

  it('given_directMessagesJoin_filtersOnIsActiveTrue_soSoftDeletedMessagesDoNotKeepFilesAlive', async () => {
    // After PR 7 added directMessages.isActive, a file linked only by soft-deleted
    // DM messages must still surface as orphaned. Otherwise soft-deleted messages
    // would keep their files alive forever and the storage quota would never reclaim.
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await findOrphanedFileRecords(db as never);

    const fullSql = sqlText(db.execute.mock.calls[0][0]);
    // Both the LEFT JOIN predicate (top-level) and the sibling-blob EXISTS subquery
    // need the isActive filter, otherwise sibling files referenced by soft-deleted
    // DMs would protect a shared blob that nothing live points at.
    expect(fullSql).toMatch(/dm\."?isActive"?\s*=\s*true/i);
    expect(fullSql).toMatch(/direct_messages.*"?isActive"?\s*=\s*true/is);
  });

  it('given_orphanCandidateRowReturned_includesCreatedByForStorageAttribution', async () => {
    // Cleanup cron must credit the uploader's storage quota. Without createdBy in
    // the row shape, conversation-only orphans would be reclaimed without ever
    // reducing the uploader's storageUsedBytes.
    const db = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { id: 'f1', storagePath: '/p/abc/original', driveId: null, sizeBytes: 4096, createdBy: 'user_uploader' },
        ],
      }),
    };

    const result = await findOrphanedFileRecords(db as never);

    expect(result[0]).toEqual(
      expect.objectContaining({ id: 'f1', createdBy: 'user_uploader' })
    );
  });

  it('given_nullDriveId_preservesNullThroughMapper', async () => {
    // After files.driveId became nullable, conversation-uploaded files surface as null.
    const db = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ id: 'f1', storagePath: '/p', driveId: null, sizeBytes: 256 }],
      }),
    };

    const result = await findOrphanedFileRecords(db as never);

    expect(result[0].driveId).toBeNull();
  });
});

describe('isFileOrphaned', () => {
  it('given_fileHasNoReferences_returnsTrue', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    };

    expect(await isFileOrphaned(db as never, 'file-1')).toBe(true);
  });

  it('given_fileHasReferences_returnsFalse', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    expect(await isFileOrphaned(db as never, 'file-1')).toBe(false);
  });

  it('given_databaseError_propagates', async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error('timeout')),
    };

    await expect(isFileOrphaned(db as never, 'file-1')).rejects.toThrow('timeout');
  });

  it('given_dmLinkageTablesExist_queryReferencesFileConversationsAndDirectMessages', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await isFileOrphaned(db as never, 'file-1');

    const fullSql = sqlText(db.execute.mock.calls[0][0]);
    expect(fullSql).toContain('file_conversations');
    expect(fullSql).toContain('direct_messages');
  });

  it('given_directMessagesJoin_filtersOnIsActiveTrue_soSoftDeletedMessagesDoNotKeepFilesAlive', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await isFileOrphaned(db as never, 'file-1');

    const fullSql = sqlText(db.execute.mock.calls[0][0]);
    expect(fullSql).toMatch(/dm\."?isActive"?\s*=\s*true/i);
  });

  it('given_sharedStoragePathDedupRequired_queryIncludesStoragePathGuard', async () => {
    // isFileOrphaned previously lacked the sibling-blob guard
    // findOrphanedFileRecords already had — both must now share it via the
    // same predicate fragment so a live sibling record protects its blob here too.
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await isFileOrphaned(db as never, 'file-1');

    const fullSql = sqlText(db.execute.mock.calls[0][0]);
    expect(fullSql).toContain('other_f');
  });
});

describe('deleteFileRecords', () => {
  // Dispatches each tx.execute call by inspecting the SQL text itself (does
  // this statement contain DELETE?) rather than by call position/count, so
  // the fake stays correct even if deleteFileRecords's statement order or
  // count changes — a position-keyed fake would silently start matching the
  // wrong statement instead of failing loudly.
  function fakeTransactionalDb(opts: {
    deleteResult?: { rows: unknown[] };
    rejectLock?: Error;
    rejectDelete?: Error;
  } = {}) {
    const executed: unknown[] = [];
    const tx = {
      execute: vi.fn((node: unknown) => {
        executed.push(node);
        const isDelete = /DELETE/i.test(sqlText(node));
        if (isDelete && opts.rejectDelete) return Promise.reject(opts.rejectDelete);
        if (!isDelete && opts.rejectLock) return Promise.reject(opts.rejectLock);
        return Promise.resolve(isDelete ? (opts.deleteResult ?? { rows: [] }) : { rows: [] });
      }),
    };
    const db = {
      transaction: vi.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    return { db, tx, executed };
  }

  it('given_fileIds_locksCandidateRowsThenRechecksAndDeletesInASeparateStatement', async () => {
    const { db, executed } = fakeTransactionalDb({
      deleteResult: { rows: [{ id: 'f1' }, { id: 'f2' }] },
    });

    const result = await deleteFileRecords(db as never, ['f1', 'f2']);

    expect(result).toEqual(['f1', 'f2']);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(executed).toHaveLength(2);

    // Statement 1: lock only, no delete — mirrors purgeInactiveMessages's
    // reasoning that folding the lock into the DELETE would keep a stale
    // pre-block snapshot and could miss a reference that committed while
    // this statement waited on the row lock.
    const lockSql = sqlText(executed[0]);
    expect(lockSql).toMatch(/FOR UPDATE/i);
    expect(lockSql).not.toMatch(/DELETE/i);

    // Statement 2: separate statement, fresh snapshot, re-verifies
    // referencedness as part of the DELETE's WHERE clause.
    const deleteSql = sqlText(executed[1]);
    expect(deleteSql).toMatch(/DELETE\s+FROM\s+files/i);
    expect(deleteSql).toMatch(/file_conversations/);
    expect(deleteSql).toMatch(/direct_messages/);
  });

  it('given_emptyArray_returnsEmptyWithoutStartingATransaction', async () => {
    const db = { transaction: vi.fn() };

    const result = await deleteFileRecords(db as never, []);

    expect(result).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('given_rowBecameReferencedBeforeRecheck_deleteSkipsItAndReturnsOnlyStillOrphanedIds', async () => {
    // Simulates the #1867 race: f2 was orphaned at scan time but a message
    // referencing it committed before the recheck statement ran, so the
    // guarded DELETE's WHERE clause (re-evaluated fresh after the lock)
    // excludes it — only f1 comes back as actually deleted.
    const { db } = fakeTransactionalDb({ deleteResult: { rows: [{ id: 'f1' }] } });

    const result = await deleteFileRecords(db as never, ['f1', 'f2']);

    expect(result).toEqual(['f1']);
  });

  it('given_databaseErrorDuringLock_propagatesAndNeverAttemptsDelete', async () => {
    const { db, tx } = fakeTransactionalDb({ rejectLock: new Error('disk full') });

    await expect(deleteFileRecords(db as never, ['f1'])).rejects.toThrow('disk full');
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it('given_databaseErrorDuringRecheckDelete_propagatesAfterLockSucceeds', async () => {
    // The old single-statement delete's error path was covered directly;
    // the two-statement split needs its own case for the SECOND statement
    // (the guarded DELETE) failing after the lock already succeeded.
    const { db, tx } = fakeTransactionalDb({ rejectDelete: new Error('constraint violation') });

    await expect(deleteFileRecords(db as never, ['f1'])).rejects.toThrow('constraint violation');
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });
});

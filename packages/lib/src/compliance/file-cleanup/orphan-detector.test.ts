/**
 * @scaffold — orphan-detector accepts `db` as a parameter but the mock
 * reproduces the ORM delete().where().returning() chain shape.
 * findOrphanedFileRecords and isFileOrphaned use raw SQL (db.execute),
 * which is a clean boundary mock.
 *
 * REVIEW: wrap deleteFileRecords in a repository seam to eliminate
 * the ORM chain mock for that function.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ _op: 'eq', col, val }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  inArray: (col: unknown, vals: unknown[]) => ({ _op: 'inArray', col, vals }),
}));

vi.mock('@pagespace/db/schema/storage', () => ({
  files: { id: 'files.id' },
}));

import {
  findOrphanedFileRecords,
  isFileOrphaned,
  deleteFileRecords,
} from './orphan-detector';
import { files } from '@pagespace/db/schema/storage';

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

  it('given_sharedStoragePathDedupRequired_queryIncludesStoragePathGuard', async () => {
    // Ensures the SQL excludes blobs shared with a live sibling file record (#905 gap).
    // Uses storagePath (the actual CAS key in the files schema) — no contentHash column exists.
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await findOrphanedFileRecords(db as never);

    const sqlArg = db.execute.mock.calls[0][0] as { strings: TemplateStringsArray };
    const fullSql = sqlArg.strings.join('');
    expect(fullSql).toContain('storagePath');
  });

  it('given_dmLinkageTablesExist_queryReferencesFileConversationsAndDirectMessages', async () => {
    // Locks in the predicate so a file with a live DM linkage is never deleted.
    // Without these joins, polymorphic uploads (PR #6 of the DM-files epic) silently
    // become harvest targets for the cleanup cron.
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await findOrphanedFileRecords(db as never);

    const sqlArg = db.execute.mock.calls[0][0] as { strings: TemplateStringsArray };
    const fullSql = sqlArg.strings.join('');
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

    const sqlArg = db.execute.mock.calls[0][0] as { strings: TemplateStringsArray };
    const fullSql = sqlArg.strings.join('');
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

    const sqlArg = db.execute.mock.calls[0][0] as { strings: TemplateStringsArray };
    const fullSql = sqlArg.strings.join('');
    expect(fullSql).toContain('file_conversations');
    expect(fullSql).toContain('direct_messages');
  });

  it('given_directMessagesJoin_filtersOnIsActiveTrue_soSoftDeletedMessagesDoNotKeepFilesAlive', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    await isFileOrphaned(db as never, 'file-1');

    const sqlArg = db.execute.mock.calls[0][0] as { strings: TemplateStringsArray };
    const fullSql = sqlArg.strings.join('');
    expect(fullSql).toMatch(/dm\."?isActive"?\s*=\s*true/i);
  });
});

describe('deleteFileRecords', () => {
  it('given_fileIds_deletesFromFilesTableAndReturnsCount', async () => {
    const mockDeleteFn = vi.fn();
    const db = {
      delete: (table: unknown) => {
        mockDeleteFn(table);
        return {
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: 'f1' }, { id: 'f2' }]),
          })),
        };
      },
    };

    const result = await deleteFileRecords(db as never, ['f1', 'f2']);

    expect(result).toBe(2);
    expect(mockDeleteFn).toHaveBeenCalledWith(files);
  });

  it('given_emptyArray_returnsZeroWithoutCallingDB', async () => {
    const db = {
      delete: vi.fn(),
    };

    const result = await deleteFileRecords(db as never, []);

    expect(result).toBe(0);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('given_databaseError_propagates', async () => {
    const db = {
      delete: () => ({
        where: () => ({
          returning: vi.fn().mockRejectedValue(new Error('disk full')),
        }),
      }),
    };

    await expect(deleteFileRecords(db as never, ['f1'])).rejects.toThrow('disk full');
  });
});

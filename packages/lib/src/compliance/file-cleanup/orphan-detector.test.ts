import { describe, it, expect, vi } from 'vitest';

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ operator: 'eq', column: col, value: val })),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  inArray: vi.fn((col, vals) => ({ operator: 'inArray', column: col, values: vals })),
}));

vi.mock('@pagespace/db', () => ({
  files: { id: 'files.id' },
}));

import {
  findOrphanedFileRecords,
  isFileOrphaned,
  deleteFileRecords,
} from './orphan-detector';

describe('findOrphanedFileRecords', () => {
  it('should return orphaned files from query results', async () => {
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
    expect(result[1].sizeBytes).toBe(2048); // string converted to number
  });

  it('should return empty array when no orphans found', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    const result = await findOrphanedFileRecords(db as never);
    expect(result).toEqual([]);
  });

  it('should handle numeric sizeBytes as-is', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ id: 'f1', storagePath: '/p', driveId: 'd1', sizeBytes: 512 }],
      }),
    };

    const result = await findOrphanedFileRecords(db as never);
    expect(result[0].sizeBytes).toBe(512);
  });
});

describe('isFileOrphaned', () => {
  it('should return true when file has no references', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    };

    const result = await isFileOrphaned(db as never, 'file-1');
    expect(result).toBe(true);
  });

  it('should return false when file has references', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    const result = await isFileOrphaned(db as never, 'file-1');
    expect(result).toBe(false);
  });
});

describe('deleteFileRecords', () => {
  it('should return count of deleted records', async () => {
    const db = {
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: 'f1' }, { id: 'f2' }]),
        })),
      })),
    };

    const result = await deleteFileRecords(db as never, ['f1', 'f2']);
    expect(result).toBe(2);
  });

  it('should return 0 for empty array without calling DB', async () => {
    const db = {
      delete: vi.fn(),
    };

    const result = await deleteFileRecords(db as never, []);
    expect(result).toBe(0);
    expect(db.delete).not.toHaveBeenCalled();
  });
});

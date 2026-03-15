/**
 * @boundary-contract - Repository layer: ORM chain mocking is necessary because file-links IS
 * the lowest persistence seam. These tests characterize query composition behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pagespace/db', () => {
  const insert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    }),
  });

  const selectChain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  };
  const select = vi.fn().mockReturnValue(selectChain);

  const db = {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = { insert, select };
      await fn(tx);
    }),
    select,
    query: {
      files: {
        findFirst: vi.fn(),
      },
    },
  };

  return {
    db,
    filePages: {
      fileId: 'filePages.fileId',
      pageId: 'filePages.pageId',
    },
    files: { id: 'files.id' },
    pages: { id: 'pages.id', driveId: 'pages.driveId' },
    eq: vi.fn((field: string, value: string) => ({ field, value, op: 'eq' })),
  };
});

import { db } from '@pagespace/db';
import { ensureFileLinked, getLinksForFile, getFileDriveId, getLinkForPage } from '../file-links';

/** @boundary-contract */
describe('ensureFileLinked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes within a transaction', async () => {
    await ensureFileLinked({
      fileId: 'file-hash',
      pageId: 'page-1',
      driveId: 'drive-1',
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(typeof (db.transaction as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('function');
  });

  it('passes optional fields through transaction', async () => {
    await ensureFileLinked({
      fileId: 'file-hash',
      pageId: 'page-1',
      driveId: 'drive-1',
      linkedBy: 'user-1',
      sizeBytes: 1024,
      mimeType: 'image/jpeg',
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('handles undefined optional fields without error', async () => {
    await expect(ensureFileLinked({
      fileId: 'file-hash',
      pageId: 'page-1',
      driveId: 'drive-1',
    })).resolves.toBeUndefined();
  });
});

/** @boundary-contract */
describe('getLinksForFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns FileLink array from query result', async () => {
    const mockRows = [
      { fileId: 'hash1', pageId: 'page-1', driveId: 'drive-1' },
    ];

    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(mockRows),
    };
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(selectChain);

    const result = await getLinksForFile('hash1');

    expect(result).toEqual(mockRows);
    expect(result[0]).toEqual(
      expect.objectContaining({ fileId: 'hash1', pageId: 'page-1', driveId: 'drive-1' })
    );
  });

  it('returns empty array when no links exist', async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(selectChain);

    const result = await getLinksForFile('hash1');
    expect(result).toEqual([]);
  });
});

describe('getFileDriveId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns driveId when file record exists', async () => {
    // Column-select query returns partial record; cast satisfies full-record mock type
    vi.mocked(db.query.files.findFirst).mockResolvedValue({ driveId: 'drive-1' } as never);

    const result = await getFileDriveId('hash1');
    expect(result).toBe('drive-1');
    expect(db.query.files.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: { driveId: true },
        where: { field: 'files.id', value: 'hash1', op: 'eq' },
      })
    );
  });

  it('returns undefined when file record not found', async () => {
    vi.mocked(db.query.files.findFirst).mockResolvedValue(undefined);

    const result = await getFileDriveId('nonexistent');
    expect(result).toBeUndefined();
  });
});

/** @boundary-contract */
describe('getLinkForPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no row found', async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(selectChain);

    const result = await getLinkForPage('page-1');
    expect(result).toBeNull();
  });

  it('returns the first row when found', async () => {
    const mockRow = { fileId: 'hash1', pageId: 'page-1', driveId: 'drive-1' };
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([mockRow]),
    };
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(selectChain);

    const result = await getLinkForPage('page-1');
    expect(result).toEqual(mockRow);
  });
});

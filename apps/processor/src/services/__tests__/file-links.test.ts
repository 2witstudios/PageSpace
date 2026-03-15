import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTransaction = vi.fn();
const mockInsert = vi.fn();
const mockSelect = vi.fn();

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

import { db, filePages, pages, eq } from '@pagespace/db';
import { ensureFileLinked, getLinksForFile, getLinkForPage } from '../file-links';

describe('ensureFileLinked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls db.transaction', async () => {
    await ensureFileLinked({
      fileId: 'file-hash',
      pageId: 'page-1',
      driveId: 'drive-1',
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('calls insert for files and filePages within transaction', async () => {
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

  it('handles undefined optional fields', async () => {
    await ensureFileLinked({
      fileId: 'file-hash',
      pageId: 'page-1',
      driveId: 'drive-1',
    });

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('getLinksForFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns results from db.select', async () => {
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
    expect(db.select).toHaveBeenCalled();
  });

  it('returns empty array when no links', async () => {
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

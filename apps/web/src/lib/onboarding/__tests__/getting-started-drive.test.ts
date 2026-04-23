import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/db', () => ({
  drives: { ownerId: 'ownerId', isTrashed: 'isTrashed', createdAt: 'createdAt' },
  users: { id: 'id' },
  db: {
    transaction: vi.fn(),
  },
  and: vi.fn((...conditions: unknown[]) => conditions),
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  asc: vi.fn((field: unknown) => ({ field, direction: 'asc' })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
}));

vi.mock('@pagespace/lib/utils/utils', () => ({
    slugify: vi.fn(),
}));

vi.mock('@/lib/onboarding/drive-setup', () => ({
  populateUserDrive: vi.fn(),
}));

import { db, drives, sql } from '@pagespace/db';
import { slugify } from '@pagespace/lib/utils/utils';
import { populateUserDrive } from '@/lib/onboarding/drive-setup';
import {
  GETTING_STARTED_DRIVE_NAME,
  provisionGettingStartedDriveIfNeeded,
} from '../getting-started-drive';

describe('provisionGettingStartedDriveIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(slugify).mockReturnValue('getting-started');
  });

  test('given user already owns a drive, should return existing drive id with created false', async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      query: {
        drives: {
          findFirst: vi.fn().mockResolvedValue({ id: 'drive-existing' }),
        },
      },
      insert: vi.fn(),
    };

    vi.mocked(db.transaction).mockImplementation((async (cb: (t: typeof tx) => unknown) => cb(tx)) as never);

    const result = await provisionGettingStartedDriveIfNeeded('user-123');

    expect(sql).toHaveBeenCalled();
    expect(tx.execute).toHaveBeenCalled();
    expect(slugify).toHaveBeenCalledWith(GETTING_STARTED_DRIVE_NAME);
    expect(result).toEqual({ driveId: 'drive-existing', created: false });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(populateUserDrive).not.toHaveBeenCalled();
  });

  test('given user owns no drives, should create and populate Getting Started drive', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'drive-123' }]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });

    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      query: {
        drives: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      },
      insert,
    };

    vi.mocked(populateUserDrive).mockResolvedValue(undefined);
    vi.mocked(db.transaction).mockImplementation((async (cb: (t: typeof tx) => unknown) => cb(tx)) as never);

    const result = await provisionGettingStartedDriveIfNeeded('user-123');

    expect(sql).toHaveBeenCalled();
    expect(tx.execute).toHaveBeenCalled();
    expect(slugify).toHaveBeenCalledWith(GETTING_STARTED_DRIVE_NAME);
    expect(insert).toHaveBeenCalledWith(drives);
    expect(values).toHaveBeenCalled();
    expect(returning).toHaveBeenCalled();
    expect(populateUserDrive).toHaveBeenCalledWith('user-123', 'drive-123', tx);
    expect(result).toEqual({ driveId: 'drive-123', created: true });
  });
});

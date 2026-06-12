import { describe, expect, test, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    transaction: vi.fn(),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { ownerId: 'ownerId', kind: 'kind', slug: 'slug' },
  pages: { driveId: 'driveId' },
}));
vi.mock('@pagespace/lib/services/drive-guards', () => ({
  HOME_DRIVE_NAME: 'Home',
  resolveUniqueSlug: vi.fn(),
}));
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('cuid-folder-1'),
}));
vi.mock('@/lib/onboarding/drive-setup', () => ({
  populateUserDrive: vi.fn(),
}));

import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { HOME_DRIVE_NAME, resolveUniqueSlug } from '@pagespace/lib/services/drive-guards';
import { populateUserDrive } from '@/lib/onboarding/drive-setup';
import {
  provisionHomeDriveIfNeeded,
  type ProvisionHomeDriveResult,
} from '../home-drive';

type OwnedDrive = { id: string; kind: string; slug: string };

type MockTx = {
  execute: ReturnType<typeof vi.fn>;
  query: {
    drives: {
      findMany: ReturnType<typeof vi.fn>;
    };
  };
  insert: ReturnType<typeof vi.fn>;
};

function makeTx(ownedDrives: OwnedDrive[] = []): MockTx {
  const driveReturning = vi.fn().mockResolvedValue([{ id: 'drive-new' }]);
  const driveValues = vi.fn().mockReturnValue({ returning: driveReturning });
  const folderReturning = vi.fn().mockResolvedValue([{ id: 'folder-1' }]);
  const folderValues = vi.fn().mockReturnValue({ returning: folderReturning });
  const insert = vi.fn()
    .mockReturnValueOnce({ values: driveValues })
    .mockReturnValueOnce({ values: folderValues });

  return {
    execute: vi.fn().mockResolvedValue(undefined),
    query: {
      drives: {
        findMany: vi.fn().mockResolvedValue(ownedDrives),
      },
    },
    insert,
  };
}

describe('provisionHomeDriveIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUniqueSlug).mockReturnValue('home');
  });

  test('given existing kind=HOME drive, returns it with created:false and makes no inserts', async () => {
    const tx = makeTx([{ id: 'drive-home-existing', kind: 'HOME', slug: 'home' }]);

    vi.mocked(db.transaction).mockImplementation((async (cb: (t: typeof tx) => unknown) => cb(tx)) as never);

    const result: ProvisionHomeDriveResult = await provisionHomeDriveIfNeeded('user-123');

    expect(sql).toHaveBeenCalled();
    expect(tx.execute).toHaveBeenCalled();
    expect(result).toEqual({ driveId: 'drive-home-existing', created: false });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(populateUserDrive).not.toHaveBeenCalled();
  });

  test('given new user (no owned drives), inserts Home with kind=HOME, seeds Getting Started folder, calls populateUserDrive, returns created:true', async () => {
    const tx = makeTx([]); // no owned drives = new user
    const driveValues = (tx.insert as ReturnType<typeof vi.fn>).mock.results; // will be populated on call
    vi.mocked(populateUserDrive).mockResolvedValue(undefined);
    vi.mocked(db.transaction).mockImplementation((async (cb: (t: typeof tx) => unknown) => cb(tx)) as never);

    const result: ProvisionHomeDriveResult = await provisionHomeDriveIfNeeded('user-new');

    expect(sql).toHaveBeenCalled();
    expect(tx.execute).toHaveBeenCalled();

    // Drive insert: kind='HOME', name=HOME_DRIVE_NAME, slug from resolveUniqueSlug
    expect(tx.insert).toHaveBeenCalledWith(drives);
    const firstInsertArg = (tx.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstInsertArg).toBe(drives);

    // Verify resolveUniqueSlug was called (slug collision protection)
    expect(resolveUniqueSlug).toHaveBeenCalled();

    // populateUserDrive called with rootParentId pointing to the folder
    expect(populateUserDrive).toHaveBeenCalledWith(
      'user-new',
      'drive-new',
      tx,
      { rootParentId: 'folder-1' }
    );

    expect(result).toEqual({ driveId: 'drive-new', created: true });
    void driveValues;
  });

  test('new user drive insert values include name=HOME_DRIVE_NAME, kind=HOME, ownerId', async () => {
    const tx = makeTx([]);
    vi.mocked(populateUserDrive).mockResolvedValue(undefined);
    vi.mocked(db.transaction).mockImplementation((async (cb: (t: typeof tx) => unknown) => cb(tx)) as never);

    await provisionHomeDriveIfNeeded('user-new');

    // First insert is the drive; check the values() call arg
    const firstCall = tx.insert as ReturnType<typeof vi.fn>;
    const valuesCall = firstCall.mock.results[0].value as { values: ReturnType<typeof vi.fn> };
    const insertedDrive = valuesCall.values.mock.calls[0][0];

    expect(insertedDrive).toMatchObject({
      name: HOME_DRIVE_NAME,
      kind: 'HOME',
      ownerId: 'user-new',
    });
    expect(insertedDrive.slug).toBe('home');
  });

  test('new user folder insert is titled "Getting Started", type FOLDER, under drive root', async () => {
    const tx = makeTx([]);
    vi.mocked(populateUserDrive).mockResolvedValue(undefined);
    vi.mocked(db.transaction).mockImplementation((async (cb: (t: typeof tx) => unknown) => cb(tx)) as never);

    await provisionHomeDriveIfNeeded('user-new');

    const insertFn = tx.insert as ReturnType<typeof vi.fn>;
    // Second insert() call is for the folder page
    const folderValuesCall = insertFn.mock.results[1].value as { values: ReturnType<typeof vi.fn> };
    const insertedFolder = folderValuesCall.values.mock.calls[0][0];

    expect(insertedFolder).toMatchObject({
      title: 'Getting Started',
      type: 'FOLDER',
      driveId: 'drive-new',
    });
    expect(insertedFolder.parentId).toBeUndefined();
  });

  test('given existing user (owns other drives) reached lazily, inserts empty Home, does NOT call populateUserDrive, returns created:false', async () => {
    const tx = makeTx([{ id: 'other-drive-1', kind: 'STANDARD', slug: 'my-drive' }]);
    vi.mocked(db.transaction).mockImplementation((async (cb: (t: typeof tx) => unknown) => cb(tx)) as never);

    const result: ProvisionHomeDriveResult = await provisionHomeDriveIfNeeded('user-existing');

    // Drive must still be inserted (lazy backfill)
    expect(tx.insert).toHaveBeenCalledWith(drives);
    const insertFn = tx.insert as ReturnType<typeof vi.fn>;
    const valuesCall = insertFn.mock.results[0].value as { values: ReturnType<typeof vi.fn> };
    const insertedDrive = valuesCall.values.mock.calls[0][0];
    expect(insertedDrive).toMatchObject({ kind: 'HOME', ownerId: 'user-existing' });

    // No folder, no seed — existing user gets empty Home
    expect(populateUserDrive).not.toHaveBeenCalled();

    // created:false — must NOT hijack their normal post-login redirect
    expect(result).toEqual({ driveId: 'drive-new', created: false });
  });

  test('given slug "home" taken, resolveUniqueSlug result is used as the drive slug', async () => {
    vi.mocked(resolveUniqueSlug).mockReturnValue('home-2');

    const tx = makeTx([{ id: 'some-drive', kind: 'STANDARD', slug: 'home' }]);
    vi.mocked(populateUserDrive).mockResolvedValue(undefined);
    vi.mocked(db.transaction).mockImplementation((async (cb: (t: typeof tx) => unknown) => cb(tx)) as never);

    await provisionHomeDriveIfNeeded('user-slug');

    const insertFn = tx.insert as ReturnType<typeof vi.fn>;
    const valuesCall = insertFn.mock.results[0].value as { values: ReturnType<typeof vi.fn> };
    const insertedDrive = valuesCall.values.mock.calls[0][0];

    expect(resolveUniqueSlug).toHaveBeenCalledWith(['home'], 'home');
    expect(insertedDrive.slug).toBe('home-2');
  });

  test('SELECT FOR UPDATE on user row is always executed for race protection', async () => {
    const tx = makeTx([{ id: 'drive-home', kind: 'HOME', slug: 'home' }]);
    vi.mocked(db.transaction).mockImplementation((async (cb: (t: typeof tx) => unknown) => cb(tx)) as never);

    await provisionHomeDriveIfNeeded('user-lock');

    expect(tx.execute).toHaveBeenCalled();
    expect(sql).toHaveBeenCalled();
  });
});

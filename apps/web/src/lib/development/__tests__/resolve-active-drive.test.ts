import { describe, test, expect } from 'vitest';
import type { Drive } from '@pagespace/lib/types';
import { resolveActiveDriveId } from '../resolve-active-drive';

const drive = (id: string, overrides: Partial<Drive> = {}): Drive => ({
  id,
  name: id,
  slug: id,
  ownerId: 'user-1',
  isTrashed: false,
  trashedAt: null,
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
  isOwned: true,
  ...overrides,
});

describe('resolveActiveDriveId', () => {
  test('prefers the drive the user was last in', () => {
    const drives = [drive('drive-1'), drive('drive-2')];

    expect(resolveActiveDriveId(drives, 'drive-2')).toBe('drive-2');
  });

  test('falls back to the first drive when there is no last-visited one', () => {
    const drives = [drive('drive-1'), drive('drive-2')];

    expect(resolveActiveDriveId(drives, null)).toBe('drive-1');
  });

  test('falls back to the first drive when the last-visited one is gone', () => {
    const drives = [drive('drive-1')];

    expect(resolveActiveDriveId(drives, 'drive-deleted')).toBe('drive-1');
  });

  test('never forwards into a trashed drive, even the last-visited one', () => {
    const drives = [drive('drive-trashed', { isTrashed: true }), drive('drive-2')];

    expect(resolveActiveDriveId(drives, 'drive-trashed')).toBe('drive-2');
  });

  test('skips trashed drives when falling back', () => {
    const drives = [drive('drive-trashed', { isTrashed: true }), drive('drive-2')];

    expect(resolveActiveDriveId(drives, null)).toBe('drive-2');
  });

  test('resolves to null when there is no drive to go to', () => {
    expect(resolveActiveDriveId([], null)).toBeNull();
    expect(resolveActiveDriveId([drive('drive-trashed', { isTrashed: true })], 'drive-trashed')).toBeNull();
  });
});

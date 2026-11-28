import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { Drive } from '@pagespace/lib/types';
import { confirmMatches, trashedDrivesOf, trashedLabel } from './account-trash-model';

const drive = (overrides: Partial<Drive> & Pick<Drive, 'id' | 'name'>): Drive => ({
  slug: overrides.id,
  ownerId: 'me',
  isTrashed: true,
  trashedAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isOwned: true,
  role: 'OWNER',
  lastAccessedAt: null,
  ...overrides,
});

describe('trashedDrivesOf', () => {
  test('lists only the viewer’s trashed drives, most recently trashed first', () => {
    const list = trashedDrivesOf(
      [
        drive({ id: 'old', name: 'Old', trashedAt: '2026-09-01T00:00:00.000Z' }),
        drive({ id: 'new', name: 'New', trashedAt: '2026-10-05T00:00:00.000Z' }),
        drive({ id: 'live', name: 'Live', isTrashed: false, trashedAt: null }),
        drive({ id: 'theirs', name: 'Theirs', ownerId: 'other' }),
      ],
      'me',
    );
    assert({
      given: 'trashed and live drives, one owned by someone else',
      should: 'list the viewer’s trashed drives, newest trash first',
      actual: list.map((item) => item.id),
      expected: ['new', 'old'],
    });
  });
});

describe('trashedLabel', () => {
  test('reads Trashed with the date, and a dash for a missing date', () => {
    assert({
      given: 'a trashed date and none',
      should: 'read Trashed with a date, or Trashed with a dash',
      actual: [trashedLabel({ trashedAt: '2026-10-01T12:00:00.000Z' }).startsWith('Trashed '), trashedLabel({ trashedAt: null })],
      expected: [true, 'Trashed —'],
    });
  });
});

describe('confirmMatches', () => {
  test('matches the name ignoring case and surrounding space, and never an empty name', () => {
    assert({
      given: 'typed text that differs from the name only by case and space',
      should: 'match; a partial name does not; an empty name never matches',
      actual: [confirmMatches('  old client work ', 'Old Client Work'), confirmMatches('Old Client', 'Old Client Work'), confirmMatches('', '')],
      expected: [true, false, false],
    });
  });
});

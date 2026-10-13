import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { Drive } from '@pagespace/lib/types';
import { DEFAULT_SORT, driveActionsOf, groupDrives, nextSort, roleLabel, sortDrives } from './account-drives-model';

const drive = (overrides: Partial<Drive> & Pick<Drive, 'id' | 'name'>): Drive => ({
  slug: overrides.id,
  ownerId: 'me',
  isTrashed: false,
  trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isOwned: true,
  role: 'OWNER',
  lastAccessedAt: null,
  ...overrides,
});

const drives = [
  drive({ id: 'a', name: 'Studio' }),
  drive({ id: 'b', name: 'archive', isOwned: false, role: 'MEMBER', ownerId: 'other' }),
  drive({ id: 'c', name: 'Home', kind: 'HOME' }),
  drive({ id: 'd', name: 'Old', isTrashed: true }),
];

describe('groupDrives', () => {
  test('favorites first, then the viewer’s own drives, then drives shared with them; trashed drives are left out', () => {
    const groups = groupDrives(drives, new Set(['c']), DEFAULT_SORT);
    assert({
      given: 'a favorite, an owned drive, a shared drive and a trashed drive',
      should: 'group them as Favorites, Personal and Shared with you, with the trashed drive absent',
      actual: groups.map((group) => [group.label, group.drives.map((item) => item.id)]),
      expected: [
        ['Favorites', ['c']],
        ['Personal', ['a']],
        ['Shared with you', ['b']],
      ],
    });
  });

  test('an empty group is not shown', () => {
    const groups = groupDrives([drive({ id: 'a', name: 'Studio' })], new Set(), DEFAULT_SORT);
    assert({
      given: 'only owned drives and no favorites',
      should: 'show Personal alone',
      actual: groups.map((group) => group.label),
      expected: ['Personal'],
    });
  });
});

describe('sortDrives and nextSort', () => {
  test('sorts by the chosen column and direction without mutating the input', () => {
    const list = [drive({ id: 'x', name: 'beta' }), drive({ id: 'y', name: 'Alpha' })];
    assert({
      given: 'name sorted descending',
      should: 'order case-insensitively and leave the input untouched',
      actual: { sorted: sortDrives(list, { key: 'name', direction: 'desc' }).map((item) => item.id), input: list.map((item) => item.id) },
      expected: { sorted: ['x', 'y'], input: ['x', 'y'] },
    });
  });

  test('sorts by last accessed, with never-accessed drives first when ascending', () => {
    const list = [
      drive({ id: 'new', name: 'n', lastAccessedAt: '2026-05-01T00:00:00.000Z' }),
      drive({ id: 'never', name: 'm', lastAccessedAt: null }),
    ];
    assert({
      given: 'one accessed drive and one never accessed',
      should: 'put the never-accessed drive first ascending',
      actual: sortDrives(list, { key: 'lastAccessedAt', direction: 'asc' }).map((item) => item.id),
      expected: ['never', 'new'],
    });
  });

  test('a header click sorts a new column ascending and flips the sorted one', () => {
    assert({
      given: 'a new column, then the same column again',
      should: 'start ascending, then flip direction',
      actual: [nextSort(DEFAULT_SORT, 'createdAt'), nextSort({ key: 'createdAt', direction: 'asc' }, 'createdAt')],
      expected: [
        { key: 'createdAt', direction: 'asc' },
        { key: 'createdAt', direction: 'desc' },
      ],
    });
  });
});

describe('driveActionsOf', () => {
  test('an owner gets Open, Rename, Favorite and Move to trash', () => {
    assert({
      given: 'a drive the viewer owns, not a favorite',
      should: 'list the four actions in menu order',
      actual: driveActionsOf({ role: 'OWNER' }, false).map((item) => item.label),
      expected: ['Open', 'Rename', 'Favorite', 'Move to trash'],
    });
  });

  test('a member gets only Open and Favorite, and a favorite reads Unfavorite', () => {
    assert({
      given: 'a shared drive the viewer favorites',
      should: 'offer Open and Unfavorite only',
      actual: driveActionsOf({ role: 'MEMBER' }, true).map((item) => item.label),
      expected: ['Open', 'Unfavorite'],
    });
  });
});

describe('roleLabel', () => {
  test('writes a role in sentence case and a missing role as a dash', () => {
    assert({
      given: 'OWNER and no role',
      should: 'read Owner and a dash',
      actual: [roleLabel('OWNER'), roleLabel(undefined)],
      expected: ['Owner', '—'],
    });
  });
});

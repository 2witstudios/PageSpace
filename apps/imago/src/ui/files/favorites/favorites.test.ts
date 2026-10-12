import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { FAVORITES, favoritesOf } from './favorites';

const body = {
  favorites: [
    { id: 'f1', itemType: 'page', position: 0, page: { id: 'plan', title: 'Q4 Launch Plan', type: 'DOCUMENT', driveId: 'studio', driveName: 'Studio' } },
    { id: 'f2', itemType: 'drive', position: 1, drive: { id: 'studio', name: 'Studio' } },
    { id: 'f3', itemType: 'page', position: 2, page: { id: 'elsewhere', title: 'Home doc', type: 'DOCUMENT', driveId: 'home', driveName: 'Home' } },
    { id: 'f4', itemType: 'page', position: 3, page: { id: 'tasks', title: 'Launch Tasks', type: 'TASK_LIST', driveId: 'studio', driveName: 'Studio' } },
    { id: 'f5', itemType: 'page', position: 4, page: { id: 'bad', title: 1, type: 'DOCUMENT', driveId: 'studio' } },
  ],
};

describe('favoritesOf() (IMC-1.8)', () => {
  test("this drive's favorite pages", () => {
    assert({
      given: "apps/web's favorites (pages and drives, every drive)",
      should: "keep this drive's pages in the user's order",
      actual: favoritesOf(body, 'studio').map((page) => [page.id, page.title, page.type]),
      expected: [['plan', 'Q4 Launch Plan', 'DOCUMENT'], ['tasks', 'Launch Tasks', 'TASK_LIST']],
    });
  });

  test('nothing loaded', () => {
    assert({ given: 'no body', should: 'list nothing', actual: favoritesOf(undefined, 'studio'), expected: [] });
  });

  test('the route', () => {
    assert({ given: 'the Favorites group', should: 'read the favorites route', actual: FAVORITES, expected: '/api/user/favorites' });
  });
});

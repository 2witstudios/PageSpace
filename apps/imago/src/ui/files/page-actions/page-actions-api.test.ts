import { describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import type { ApiClient } from '@/api/client';
import { addFavorite, bulkTrash, favoriteIdOf, pageActionPaths, removeFavorite, setHomePage, setPageProtected } from './page-actions-api';

const fakeClient = (responses: Record<string, unknown> = {}) => {
  const calls: { path: string; init?: unknown }[] = [];
  const apiFetch = vi.fn(async (path: string, init?: unknown) => {
    calls.push({ path, init });
    return responses[path] ?? null;
  });
  const client = { apiFetch, apiStream: vi.fn() } as unknown as ApiClient;
  return { client, calls };
};

describe('favoriteIdOf()', () => {
  test('the favorite row id of a page, from the favorites list', () => {
    assert({
      given: 'a favorites list with a page and a drive',
      should: 'return the row id of the page, not the drive',
      actual: favoriteIdOf(
        {
          favorites: [
            { id: 'row-drive', itemType: 'drive', drive: { id: 'plan' } },
            { id: 'row-page', itemType: 'page', page: { id: 'plan' } },
          ],
        },
        'plan',
      ),
      expected: 'row-page',
    });
  });

  test('undefined when the page is not favorited', () => {
    assert({
      given: 'a favorites list without the page',
      should: 'return undefined',
      actual: favoriteIdOf({ favorites: [] }, 'plan'),
      expected: undefined,
    });
  });
});

describe('menu writes (IMC-9.3)', () => {
  test('favoriting posts the page as an item', async () => {
    const { client, calls } = fakeClient();
    await addFavorite(client, 'plan');
    assert({
      given: 'a page to favorite',
      should: 'POST /api/user/favorites with itemType page and the page id',
      actual: calls.map((call) => [call.path, call.init]),
      expected: [[pageActionPaths.favorites, { method: 'POST', json: { itemType: 'page', itemId: 'plan' } }]],
    });
  });

  test('unfavoriting looks up the server row first, then deletes that row', async () => {
    const { client, calls } = fakeClient({
      [pageActionPaths.favorites]: { favorites: [{ id: 'row-page', itemType: 'page', page: { id: 'plan' } }] },
    });
    await removeFavorite(client, 'plan');
    assert({
      given: 'a favorited page',
      should: 'read the favorites, then DELETE the favorite row',
      actual: calls.map((call) => call.path),
      expected: [pageActionPaths.favorites, pageActionPaths.favorite('row-page')],
    });
  });

  test('protecting patches the page isPrivate flag', async () => {
    const { client, calls } = fakeClient();
    await setPageProtected(client, 'plan', true);
    assert({
      given: 'a page to protect',
      should: 'PATCH /api/pages/[id] with isPrivate true',
      actual: calls[0],
      expected: { path: '/api/pages/plan', init: { method: 'PATCH', json: { isPrivate: true } } },
    });
  });

  test('the home page is set on the drive, and cleared with null', async () => {
    const { client, calls } = fakeClient();
    await setHomePage(client, 'd1', null);
    assert({
      given: 'removing the drive home page',
      should: 'PATCH /api/drives/[id] with homePageId null',
      actual: calls[0],
      expected: { path: '/api/drives/d1', init: { method: 'PATCH', json: { homePageId: null } } },
    });
  });

  test('bulk trash sends every page id with their children, as the bulk route reads it', async () => {
    const { client, calls } = fakeClient();
    await bulkTrash(client, ['a', 'b', 'c']);
    assert({
      given: 'three pages picked in multi-select',
      should: 'DELETE /api/pages/bulk-delete with the ids and trashChildren',
      actual: calls[0],
      expected: {
        path: '/api/pages/bulk-delete',
        init: { method: 'DELETE', json: { pageIds: ['a', 'b', 'c'], trashChildren: true } },
      },
    });
  });
});

describe('favoriteIdOf() on malformed bodies', () => {
  test('is undefined for anything that is not a favorites list', () => {
    assert({ given: 'null', should: 'return undefined', actual: favoriteIdOf(null, 'plan'), expected: undefined });
    assert({ given: 'a body without a favorites array', should: 'return undefined', actual: favoriteIdOf({ favorites: 'x' }, 'plan'), expected: undefined });
  });

  test('skips entries that are not objects', () => {
    assert({
      given: 'a list with junk entries before the match',
      should: 'still find the page',
      actual: favoriteIdOf({ favorites: [null, 'x', { id: 'row', itemType: 'page', page: { id: 'plan' } }] }, 'plan'),
      expected: 'row',
    });
  });

  test('does not match an entry whose page reference is missing', () => {
    assert({
      given: 'a page favorite with no page',
      should: 'return undefined',
      actual: favoriteIdOf({ favorites: [{ id: 'row', itemType: 'page' }] }, 'plan'),
      expected: undefined,
    });
  });
});

describe('removeFavorite() when the server does not have the favorite', () => {
  test('makes no DELETE', async () => {
    const { client, calls } = fakeClient({ [pageActionPaths.favorites]: { favorites: [] } });
    await removeFavorite(client, 'plan');
    assert({ given: 'a page that is not in the server list', should: 'only read the list', actual: calls.length, expected: 1 });
  });
});
